const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

const questions = [
  {
    text: 'What is the capital of the Philippines?',
    choices: ['Cebu', 'Davao', 'Manila', 'Baguio'],
    correct: 2,
    timeLimit: 15
  },
  {
    text: 'What is 5 x 6?',
    choices: ['11', '30', '25', '60'],
    correct: 1,
    timeLimit: 10
  },
  {
    text: 'Which planet is known as the Red Planet?',
    choices: ['Earth', 'Mars', 'Venus', 'Jupiter'],
    correct: 1,
    timeLimit: 12
  }
];

let players = {};
let teacherSocketId = null;
const TEACHER_PASSKEY = 'froyoo';
let currentQuestion = -1;
let quizStarted = false;
let answered = {};
let questionStartedAt = null;
let revealAnswer = false;



function saveResultsToFile() {
  const leaderboard = Object.values(players)
    .sort((a, b) => b.score - a.score);

  let text = 'QUIZ RESULTS\n\n';

  leaderboard.forEach((p, i) => {
    text += (i + 1) + '. ' + p.name + ' - ' + p.score + ' points\n';
  });

  // 🔥 find next available filename
  let counter = 1;
  let filename = '';

  do {
    filename = `results_${Date.now()}_${counter}.txt`;
    counter++;
  } while (fs.existsSync(filename));

  // ✅ save file
  fs.writeFileSync(filename, text);

  console.log('Saved as:', filename);
}

function getLeaderboard() {
  return Object.values(players).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function getPublicQuestion() {
  if (currentQuestion < 0 || currentQuestion >= questions.length) return null;
  const q = questions[currentQuestion];
  return {
    text: q.text,
    choices: q.choices,
    timeLimit: q.timeLimit
  };
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

app.get('/', (req, res) => {
  res.send(`
    
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Quiz App</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #111827;
      color: white;
      margin: 0;
      padding: 20px;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    .card {
      background: #1f2937;
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 20px;
    }
    input, button {
      padding: 12px;
      border-radius: 10px;
      border: none;
      margin: 6px 0;
      font-size: 16px;
    }
    input {
      width: 100%;
      box-sizing: border-box;
    }
    button {
      cursor: pointer;
      background: #2563eb;
      color: white;
      margin-right: 8px;
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .choice {
      display: block;
      width: 100%;
      margin-bottom: 10px;
      text-align: left;
      background: #374151;
    }
    .teacher-only {
      display: none;
    }
    .show {
      display: block;
    }
    .muted {
      color: #9ca3af;
    }
    .good {
      color: #4ade80;
    }
    .bad {
      color: #f87171;
    }
    .timer {
      font-size: 30px;
      font-weight: bold;
      margin: 10px 0;
    }
    .badge {
      display: inline-block;
      padding: 6px 10px;
      background: #111827;
      border-radius: 999px;
      margin-right: 6px;
      margin-bottom: 6px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Quiz App</h1>
      <p class="muted">Students join on the same hotspot or Wi-Fi. Only the teacher device can control the quiz.</p>
    </div>

    <div class="card" id="teacherCard">
      <h2>Teacher Panel</h2>
      <input id="teacherPasskey" placeholder="Enter teacher passkey" />
      <button onclick="startTeacherMode()">Unlock Teacher Panel</button>
      <div id="teacherControls" style="display:none; margin-top: 12px;">
        <button onclick="startQuiz()">Start Quiz</button>
        <button onclick="nextQuestion()">Next Question</button>
        <button onclick="revealNow()">Reveal Answer</button>
        <button onclick="resetQuiz()">Reset Quiz</button>
        <button onclick="saveResults()">Save Results</button>
      </div>
      <div id="teacherStatus" class="muted"></div>
    </div>

    <div class="card" id="studentCard">
      <h2>Student Join</h2>
      <input id="name" placeholder="Your name" maxlength="20" />
      <button onclick="joinQuiz()">Join Quiz</button>
      <div id="me" class="muted"></div>
    </div>

    <div class="card">
      <h2 id="questionTitle">Waiting for teacher...</h2>
      <div class="timer" id="timer">--</div>
      <div id="choices"></div>
      <div id="result"></div>
    </div>

    <div class="card">
      <h2>Leaderboard</h2>
      <div id="leaderboard"></div>
    </div>
  </div>

  <script>
    const socket = io();
    let teacherMode = false;
    let myAnswered = false;
    let mySelected = null;
    let timerInterval = null;


    function saveResults() {
        socket.emit('teacher:save');
        }

    function startTeacherMode() {
      const passkey = document.getElementById('teacherPasskey').value.trim();
      socket.emit('teacher:claim', passkey);
    }

    function joinQuiz() {
      const name = document.getElementById('name').value.trim();
      if (!name) {
        alert('Enter your name first.');
        return;
      }
      socket.emit('join', name);
    }

    function startQuiz() {
      socket.emit('teacher:start');
    }

    function nextQuestion() {
      socket.emit('teacher:next');
    }

    function revealNow() {
      socket.emit('teacher:reveal');
    }

    function resetQuiz() {
      socket.emit('teacher:reset');
    }

    function answer(index) {
      if (myAnswered) return;
      myAnswered = true;
      mySelected = index;
      socket.emit('answer', index);
      document.getElementById('result').innerHTML = '<p class="muted">Answer submitted. Waiting for result...</p>';
    }

    function renderLeaderboard(players) {
      const html = players.map((p, i) => {
        return '<div class="badge">#' + (i + 1) + ' ' + p.name + ' - ' + p.score + '</div>';
      }).join('');
      document.getElementById('leaderboard').innerHTML = html || '<p class="muted">No players yet.</p>';
    }

    function startTimer(seconds) {
      clearInterval(timerInterval);
      let current = seconds;
      document.getElementById('timer').innerText = current > 0 ? current + 's' : '--';
      if (seconds <= 0) return;

      timerInterval = setInterval(() => {
        current -= 1;
        document.getElementById('timer').innerText = current > 0 ? current + 's' : '0s';
        if (current <= 0) clearInterval(timerInterval);
      }, 1000);
    }

    socket.on('update', data => {
      renderLeaderboard(data.players || []);


      if (!data.quizStarted || !data.question) {
        document.getElementById('questionTitle').innerText = 'Waiting for teacher...';
        document.getElementById('choices').innerHTML = '';
        document.getElementById('timer').innerText = '--';
        return;
      }

      document.getElementById('questionTitle').innerText = 'Question ' + (data.currentQuestion + 1) + ' of ' + data.totalQuestions + ': ' + data.question.text;
      startTimer(data.timeLeft || data.question.timeLimit || 0);

      const buttons = data.question.choices.map((c, i) => {
        let extra = '';
        if (data.revealAnswer && data.correctAnswer === i) {
          extra = ' ✅';
        }
        return '<button class="choice" onclick="answer(' + i + ')" ' + ((myAnswered || data.revealAnswer) ? 'disabled' : '') + '>' + c + extra + '</button>';
      }).join('');

      document.getElementById('choices').innerHTML = buttons;

      if (data.revealAnswer) {
        if (mySelected === null) {
          document.getElementById('result').innerHTML = '<p class="bad">No answer submitted.</p>';
        } else if (mySelected === data.correctAnswer) {
          document.getElementById('result').innerHTML = '<p class="good">Correct answer.</p>';
        } else {
          document.getElementById('result').innerHTML = '<p class="bad">Wrong answer.</p>';
        }
      }
    });

    socket.on('teacher:granted', () => {
      teacherMode = true;
      document.getElementById('teacherControls').style.display = 'block';
      document.getElementById('teacherStatus').innerText = 'Teacher controls enabled on this device.';
    });

    socket.on('teacher:denied', (msg) => {
      teacherMode = false;
      alert(msg || 'Teacher access denied.');
    });

    socket.on('joined', data => {
      document.getElementById('me').innerText = 'Joined as ' + data.name;
    });

    socket.on('new-question', () => {
      myAnswered = false;
      mySelected = null;
      document.getElementById('result').innerHTML = '';
    });

    socket.on('error-message', msg => {
      alert(msg);
    });
  </script>
</body>
</html>
  `);
});

io.on('connection', (socket) => {
  socket.on('teacher:claim', (passkey) => {
    if (String(passkey || '').trim() !== TEACHER_PASSKEY) {
      socket.emit('teacher:denied', 'Wrong teacher passkey.');
      return;
    }
    teacherSocketId = socket.id;
    socket.emit('teacher:granted');
  });
    socket.on('teacher:save', () => {
        if (socket.id !== teacherSocketId) return;
        saveResultsToFile();
    });

  socket.on('join', name => {
    const cleanName = String(name || '').trim().slice(0, 20);
    if (!cleanName) {
      socket.emit('error-message', 'Invalid name.');
      return;
    }
    players[socket.id] = {
      name: cleanName,
      score: players[socket.id] ? players[socket.id].score : 0
    };
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

            // 👉 SAVE RESULTS HERE
            saveResultsToFile();

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
    Object.keys(players).forEach(id => {
      players[id].score = 0;
    });
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

    answered[socket.id] = {
      index: Number(index),
      isCorrect,
      answerTimeMs
    };

    if (isCorrect) {
      const points = calculateSpeedScore(answerTimeMs, q.timeLimit);
      players[socket.id].score += points;
    }

    broadcast();
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    delete answered[socket.id];
    if (teacherSocketId === socket.id) {
      teacherSocketId = null;
    }
    broadcast();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server running at http://0.0.0.0:3000');
});
