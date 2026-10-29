'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const PDFDocument = require('pdfkit');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const TEACHER_PASSKEY = process.env.TEACHER_PASSKEY;
if (!TEACHER_PASSKEY) { console.error('Set TEACHER_PASSKEY in environment before starting Quiz App.'); process.exit(1); }
const seedQuestions = [
  { text:'What is the capital of the Philippines?', choices:['Cebu','Davao','Manila','Baguio'], correct:2, timeLimit:15 },
  { text:'What is 5 x 6?', choices:['11','30','25','60'], correct:1, timeLimit:10 }
];
const sessions = new Map();
const teachers = new Map();
const students = new Map();
const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function makeCode() { let code; do { code = Array.from({length:6},()=>ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]).join(''); } while (sessions.has(code)); return code; }
function room(code) { return `quiz:${code}`; }
function validateQuestions(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 200) return null;
  const cleaned=[];
  for(const q of list) {
    if(!q || typeof q.text !== 'string' || !q.text.trim() || q.text.length > 1000 || !Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 8 || q.choices.some(c=>typeof c !== 'string' || !c.trim() || c.length > 500) || !Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.choices.length || !Number.isInteger(q.timeLimit) || q.timeLimit < 5 || q.timeLimit > 300) return null;
    cleaned.push({text:q.text.trim(),choices:q.choices.map(c=>c.trim()),correct:q.correct,timeLimit:q.timeLimit});
  }
  return cleaned;
}
function publicPlayers(s) { return [...s.roster.values()].map(p=>({name:p.name,score:p.score,status:p.connected?'connected':'disconnected',key:p.key})).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)); }
function timeLeft(s) { if(!s.started || s.questionIndex<0) return 0; return Math.max(0,Math.ceil((s.questionStart+s.questions[s.questionIndex].timeLimit*1000-Date.now())/1000)); }
function publicState(s) { const q=s.questions[s.questionIndex]; return {roomCode:s.code,players:publicPlayers(s),connectedCount:[...s.roster.values()].filter(p=>p.connected).length,disconnectedCount:[...s.roster.values()].filter(p=>!p.connected).length,question:s.started&&q?{text:q.text,choices:q.choices,timeLimit:q.timeLimit}:null,questionIndex:s.questionIndex,totalQuestions:s.questions.length,started:s.started,revealed:s.revealed,correctAnswer:s.revealed&&q?q.correct:null,timeLeft:timeLeft(s),round:s.round}; }
function broadcast(s) { io.to(room(s.code)).emit('update',publicState(s)); }
function requireTeacher(socket) { const code=teachers.get(socket.id); return code?sessions.get(code):null; }
function startQuestion(s,index) {
  if(s.timer) clearTimeout(s.timer);
  s.questionIndex=index; s.started=true; s.revealed=false; s.round++; s.answers.clear(); s.questionStart=Date.now();
  broadcast(s);
  const round=s.round;
  s.timer=setTimeout(()=>{if(s.round===round&&s.started&&!s.revealed){s.revealed=true;broadcast(s);}},s.questions[index].timeLimit*1000);
}
function generatePdf(socket,s) {
  const doc=new PDFDocument({margin:48}); const chunks=[];
  doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>socket.emit('teacher:pdf-ready',Buffer.concat(chunks)));
  doc.fontSize(22).text(`Quiz App Results — ${s.code}`,{align:'center'}).moveDown();
  doc.fontSize(11).text(`Exported: ${new Date().toISOString()}`).moveDown();
  publicPlayers(s).forEach((p,i)=>doc.fontSize(12).text(`${i+1}. ${p.name} — ${p.score} points (${p.status})`).moveDown(0.4));
  doc.end();
}
function dropStudent(socket,reason) {
  const entry=students.get(socket.id); if(!entry)return;
  students.delete(socket.id); socket.leave(room(entry.code));
  const s=sessions.get(entry.code); if(!s)return;
  const p=s.roster.get(entry.key); if(p && p.socketId===socket.id){p.connected=false;p.socketId=null;}
  // Answers are keyed by student identity and round, preserving attempts after reconnect.
  if(reason) socket.emit('room:left',reason);
  broadcast(s);
}
io.on('connection',socket=>{
  socket.on('teacher:claim',passkey=>{
    if(typeof passkey!=='string'||passkey!==TEACHER_PASSKEY){socket.emit('teacher:denied','Invalid teacher passkey.');return;}
    if(teachers.has(socket.id)){socket.emit('teacher:granted',{code:teachers.get(socket.id)});return;}
    const code=makeCode();const s={code,teacherId:socket.id,questions:seedQuestions.map(q=>({...q,choices:[...q.choices]})),roster:new Map(),answers:new Map(),questionIndex:-1,started:false,revealed:false,round:0,questionStart:0,timer:null,removed:new Set()};
    sessions.set(code,s);teachers.set(socket.id,code);socket.join(room(code));socket.emit('teacher:granted',{code});broadcast(s);
  });
  socket.on('join',data=>{
    if(teachers.has(socket.id))return socket.emit('error-message','Teacher devices cannot join as students.');
    const code=String(data?.code||'').trim().toUpperCase();const name=String(data?.name||'').trim().slice(0,40);
    const s=sessions.get(code);
    if(!s)return socket.emit('error-message','Invalid or expired room code.');
    if(!name)return socket.emit('error-message','Enter your name.');
    const key=name.toLocaleLowerCase();const existing=s.roster.get(key);
    if(s.removed.has(key))return socket.emit('error-message','The teacher removed this name from the room. Ask the teacher to reset the quiz before joining again.');
    if(existing?.connected)return socket.emit('error-message','That name is already connected.');
    if(students.has(socket.id))dropStudent(socket);
    const p=existing||{name,key,score:0,connected:false,socketId:null};p.name=name;p.connected=true;p.socketId=socket.id;s.roster.set(key,p);
    students.set(socket.id,{code,key});socket.join(room(code));socket.emit('joined',{name,code,round:s.round,alreadyAnswered:s.answers.has(key)});broadcast(s);
  });
  socket.on('teacher:load-questions',list=>{const s=requireTeacher(socket);if(!s)return;const valid=validateQuestions(list);if(!valid)return socket.emit('error-message','Invalid questions JSON (1–200 questions; 2–8 choices; 5–300 seconds).');s.questions=valid;reset(s);socket.emit('teacher:questions-loaded');});
  function reset(s){if(s.timer)clearTimeout(s.timer);s.started=false;s.revealed=false;s.questionIndex=-1;s.round++;s.answers.clear();s.questionStart=0;for(const p of s.roster.values())p.score=0;s.removed.clear();broadcast(s);}
  socket.on('teacher:reset',()=>{const s=requireTeacher(socket);if(s)reset(s);});
  socket.on('teacher:start',()=>{const s=requireTeacher(socket);if(s&&!s.started)startQuestion(s,0);});
  socket.on('teacher:next',()=>{const s=requireTeacher(socket);if(!s||!s.started)return;if(s.questionIndex+1>=s.questions.length){s.revealed=true;if(s.timer)clearTimeout(s.timer);broadcast(s);generatePdf(socket,s);return;}startQuestion(s,s.questionIndex+1);});
  socket.on('teacher:reveal',()=>{const s=requireTeacher(socket);if(s&&s.started){s.revealed=true;if(s.timer)clearTimeout(s.timer);broadcast(s);}});
  socket.on('teacher:remove',key=>{
    const s=requireTeacher(socket);if(!s)return;
    const id=String(key||'').trim().toLocaleLowerCase();const p=s.roster.get(id);if(!p)return socket.emit('error-message','Participant not found.');
    s.removed.add(id);s.roster.delete(id);s.answers.delete(id);
    if(p.socketId){const peer=io.sockets.sockets.get(p.socketId);if(peer){students.delete(p.socketId);peer.leave(room(s.code));peer.emit('room:left','You were removed from the quiz by the teacher.');}}
    broadcast(s);
  });
  socket.on('teacher:save',()=>{const s=requireTeacher(socket);if(s)generatePdf(socket,s);});
  socket.on('answer',raw=>{
    const entry=students.get(socket.id);if(!entry)return;const s=sessions.get(entry.code);if(!s||!s.started||s.revealed||s.answers.has(entry.key)||timeLeft(s)<=0)return;
    const p=s.roster.get(entry.key);if(!p||!p.connected||p.socketId!==socket.id)return;
    const q=s.questions[s.questionIndex],index=Number(raw);if(!Number.isInteger(index)||index<0||index>=q.choices.length)return;
    const correct=index===q.correct;const elapsed=Math.max(0,Date.now()-s.questionStart);
    const points=correct?Math.round(50+50*(1-Math.min(elapsed,q.timeLimit*1000)/(q.timeLimit*1000))):0;
    if(correct)p.score+=points;s.answers.set(entry.key,{index,correct,points});socket.emit('answer:receipt',{round:s.round,points,correct});broadcast(s);
  });
  socket.on('disconnect',()=>{
    dropStudent(socket);
    const code=teachers.get(socket.id);if(code){teachers.delete(socket.id);const s=sessions.get(code);if(s){if(s.timer)clearTimeout(s.timer);sessions.delete(code);for(const p of s.roster.values())if(p.socketId){const peer=io.sockets.sockets.get(p.socketId);if(peer){students.delete(p.socketId);peer.leave(room(code));peer.emit('room:left','The teacher has left; this room is closed.');}}}}
  });
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Quiz App running on port ${PORT}`));
