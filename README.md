# Quiz App upgrade

Replace the repository's `server.js`, `public/index.html`, `public/styles.css`, and `package.json` with these files. Keep its existing `package-lock.json`, then run `npm install` to synchronize it.

## Run

Set `TEACHER_PASSKEY` to a private secret in the hosting provider environment before starting. For local Bash: `TEACHER_PASSKEY='change-this-secret' npm start`. For PowerShell: `$env:TEACHER_PASSKEY='change-this-secret'; npm start`.

The teacher unlocks the hidden teacher area and gets a random six-character room code. Students enter their names and the code. Multiple teachers can host isolated in-memory rooms. A participant disconnected from Socket.IO is removed from the active Socket.IO room; the teacher retains a disconnected roster entry. New students can join even while the quiz is running. Disconnected students may manually rejoin the same active room using their original name and room code, recovering their score and retaining their current-round answer status. The teacher can remove connected or disconnected participants using Remove. Removed names are blocked from rejoining until the teacher resets the quiz. There is no automatic rejoin, and new questions are not sent to disconnected or removed students.

Correct answers earn between 50 and 100 points, depending on elapsed time; wrong answers earn zero. PDF export, custom JSON questions, timer, start/next/reveal/reset, and leaderboard remain available.

## Limitations

Rooms and results are stored in server memory. Restarting the server clears rooms, scores, and custom questions. Use a single application instance; distributed scaling requires a shared store and Socket.IO adapter. The original code exposed a hard-coded teacher passkey: rotate it and use environment settings. No account system or database persistence is implemented. Disconnect recognition follows Socket.IO heartbeat detection rather than immediate physical network loss. Existing questions already shown on a device cannot be remotely erased after it loses internet, but the client clears them when Socket.IO reports disconnect; the server sends no subsequent questions to that socket.
