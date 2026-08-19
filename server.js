const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PDFDocument = require('pdfkit');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Increase max payload size in case the PDF gets large
const io = new Server(server, { maxHttpBufferSize: 1e8 }); 

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

let questions = [
  { text: 'What is the capital of the Philippines?', choices: ['Cebu', 'Davao', 'Manila', 'Baguio'], correct: 2, timeLimit: 15 },
  { text: 'What is 5 x 6?', choices: ['11', '30', '25', '60'], correct: 1, timeLimit: 10 },
  { text: 'Which planet is known as the Red Planet?', choices: ['Earth', 'Mars', 'Venus', 'Jupiter'], correct: 1, timeLimit: 12 }
];

let players = {};
let persistentScores = {}; // Add this new line to remember scores
let teacherSocketId = null;
const TEACHER_PASSKEY = 'froyoo0120';
let currentQuestion = -1;
let quizStarted = false;
let answered = {};
let questionStartedAt = null;
let revealAnswer = false;

// Generate PDF in memory and send it to the teacher
function saveResultsToPDF(teacherSocket) {
  const leaderboard = Object.values(players).sort((a, b) => b.score - a.score);
  
  const doc = new PDFDocument({ margin: 50 });
  
  // Store PDF data in chunks instead of writing to a file
  let buffers = [];
  doc.on('data', buffers.push.bind(buffers));
  
  doc.on('end', () => {
    // Combine chunks into a single Buffer
    const pdfData = Buffer.concat(buffers);
    if (teacherSocket) {
      // Send the binary PDF data directly to the browser
      teacherSocket.emit('teacher:pdf-ready', pdfData);
    }
  });

  // Build the PDF content
  doc.fontSize(24).font('Helvetica-Bold').text('Quiz Results', { align: 'center' });
  doc.moveDown();
  doc.fontSize(14).font('Helvetica').text(`Date: ${new Date().toLocaleString()}`, { align: 'center' });
  doc.moveDown(2);

  leaderboard.forEach((p, i) => {
    doc.fontSize(16).text(`${i + 1}. ${p.name}`, { continued: true });
    doc.text(` — ${p.score} points`, { align: 'right' });
    doc.moveDown(0.5);
  });

  doc.end();
}

function getLeaderboard() {
  return Object.values(players).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function getPublicQuestion() {
  if (currentQuestion < 0 || currentQuestion >= questions.length) return null;
  const q = questions[currentQuestion];
  return { text: q.text, choices: q.choices, timeLimit: q.timeLimit };
}

function getTimeLeftSeconds() {
  if (!quizStarted || currentQuestion < 0 || !questionStartedAt) return 0;
  const q = questions[currentQuestion];
  const elapsed = (Date.now() - questionStartedAt) / 1000;
  return Math.max(0, Math.ceil(q.timeLimit - elapsed));
}

function broadcast() {
  io.emit('update', {
    players: getLeaderboard(),
    question: getPublicQuestion(),
    quizStarted,
    currentQuestion,
    totalQuestions: questions.length,
    revealAnswer,
    correctAnswer: revealAnswer && currentQuestion >= 0 ? questions[currentQuestion].correct : null,
    timeLeft: getTimeLeftSeconds()
  });
}

function resetQuestionState() {
  answered = {};
  questionStartedAt = Date.now();
  revealAnswer = false;
}

function startQuestion(index) {
  if (index < 0 || index >= questions.length) return;
  currentQuestion = index;
  quizStarted = true;
  resetQuestionState();
  broadcast();

  setTimeout(() => {
    if (quizStarted && currentQuestion === index && !revealAnswer) {
      revealAnswer = true;
      broadcast();
    }
  }, questions[index].timeLimit * 1000);
}

function calculateSpeedScore(answerTimeMs, timeLimitSeconds) {
  const maxPoints = 100;
  const minPoints = 20;
  const timeLimitMs = timeLimitSeconds * 1000;
  const safeAnswerTime = Math.max(0, Math.min(answerTimeMs, timeLimitMs));
  const speedRatio = 1 - (safeAnswerTime / timeLimitMs);
  return Math.round(minPoints + (speedRatio * (maxPoints - minPoints)));
}

io.on('connection', (socket) => {
  socket.on('teacher:claim', (passkey) => {
    if (String(passkey || '').trim() !== TEACHER_PASSKEY) {
      socket.emit('teacher:denied', 'Wrong teacher passkey.');
      return;
    }
    teacherSocketId = socket.id;
    socket.emit('teacher:granted');
  });

  socket.on('teacher:load-questions', (newQuestions) => {
    if (socket.id !== teacherSocketId) return;
    if (Array.isArray(newQuestions) && newQuestions.length > 0) {
      questions = newQuestions; 
      currentQuestion = -1;
      quizStarted = false;
      answered = {};
      questionStartedAt = null;
      revealAnswer = false;
      Object.keys(players).forEach(id => players[id].score = 0);
      
      io.emit('new-question');
      broadcast();
      socket.emit('teacher:questions-loaded');
    }
  });

  socket.on('teacher:save', () => {
    if (socket.id !== teacherSocketId) return;
    saveResultsToPDF(socket); 
  });

  socket.on('join', name => {
    const cleanName = String(name || '').trim().slice(0, 20);
    if (!cleanName) {
      socket.emit('error-message', 'Invalid name.');
      return;
    }
    
    // Restore score if they refreshed, or start at 0
    if (persistentScores[cleanName] === undefined) {
      persistentScores[cleanName] = 0;
    }
    
    players[socket.id] = { name: cleanName, score: persistentScores[cleanName] };
    socket.emit('joined', { name: cleanName });
    broadcast();
  });

  socket.on('teacher:start', () => {
    if (socket.id !== teacherSocketId) return;
    startQuestion(0);
    io.emit('new-question');
  });

  socket.on('teacher:next', () => {
    if (socket.id !== teacherSocketId) return;
    if (currentQuestion + 1 >= questions.length) {
      revealAnswer = true;
      broadcast();
      saveResultsToPDF(socket);
      return;
    }
    startQuestion(currentQuestion + 1);
    io.emit('new-question');
  });

  socket.on('teacher:reveal', () => {
    if (socket.id !== teacherSocketId) return;
    revealAnswer = true;
    broadcast();
  });

  socket.on('teacher:reset', () => {
    if (socket.id !== teacherSocketId) return;
    currentQuestion = -1;
    quizStarted = false;
    answered = {};
    questionStartedAt = null;
    revealAnswer = false;
    Object.keys(players).forEach(id => players[id].score = 0);
    persistentScores = {};
    io.emit('new-question');
    broadcast();
  });

  socket.on('answer', index => {
    if (!quizStarted || currentQuestion < 0 || revealAnswer) return;
    if (!players[socket.id]) return;
    if (answered[socket.id]) return;

    const q = questions[currentQuestion];
    const answerTimeMs = Date.now() - questionStartedAt;
    const isCorrect = Number(index) === q.correct;

    answered[socket.id] = { index: Number(index), isCorrect, answerTimeMs };

    if (isCorrect) {
      const points = calculateSpeedScore(answerTimeMs, q.timeLimit);
      players[socket.id].score += points;
      // Add this line below to permanently back up the new score
      persistentScores[players[socket.id].name] = players[socket.id].score; 
    }

    broadcast();
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    delete answered[socket.id];
    if (teacherSocketId === socket.id) teacherSocketId = null;
    broadcast();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});