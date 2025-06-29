const canvas = document.getElementById('trackCanvas');
const ctx = canvas.getContext('2d');
const cellSize = 20;

let trackImageData = null;
let trackWidth = 0;
let trackHeight = 0;

let players = [];
let currentPlayerIndex = 0;
let moveTrails = [];
let hoverTarget = null;
let legalMoves = [];
let selectedMoveIndex = 0;
let previousMovesKey = '';
const PLAYER_COLORS = ['red', 'blue', 'green', 'orange'];

function setupPlayers() {
  const count = parseInt(document.getElementById('playerCount').value);
  players = [];
  moveTrails = [];
  currentPlayerIndex = 0;

  const starts = [];

  for (let y = 0; y < trackHeight; y++) {
    for (let x = 0; x < trackWidth; x++) {
      const color = getPixelColor(x, y);
      if (color === 'start') starts.push({x, y});
    }
  }

  if (starts.length < count) {
    alert('Not enough start tiles!');
    return;
  }

  for (let i = 0; i < count; i++) {
    players.push({
      x: starts[i].x,
      y: starts[i].y,
      vx: 0,
      vy: 0,
      alive: true,
      color: PLAYER_COLORS[i]
    });
    moveTrails.push([]);
  }

  redrawGame();
}

function getPixelColor(x, y) {
  if (!trackImageData || x < 0 || y < 0 || x >= trackWidth || y >= trackHeight)
    return 'wall';
  const i = (y * trackWidth + x) * 4;
  const r = trackImageData[i], g = trackImageData[i + 1],
        b = trackImageData[i + 2];
  const hex = (r << 16) | (g << 8) | b;
  switch (hex) {
    case 0x0000ff:
      return 'wall';
    case 0x7f7f7f:
      return 'curb';
    case 0xffff00:
      return 'gravel';
    case 0x000000:
      return 'finish';
    case 0x00ffff:
      return 'start';
    default:
      return 'road';
  }
}

function getLegalMoves() {
  const p = players[currentPlayerIndex];
  const moves = [];
  const surface = getPixelColor(p.x, p.y);

  for (let ax = -1; ax <= 1; ax++) {
    for (let ay = -1; ay <= 1; ay++) {
      const vx = p.vx + ax, vy = p.vy + ay;
      const x = p.x + vx, y = p.y + vy;

      if (!isInsideTrack(x, y)) continue;

      let allowed = true;
      if (surface === 'curb')
        allowed = (ax === 0 && ay === 0);
      else if (surface === 'gravel')
        allowed = Math.sqrt(vx * vx + vy * vy) <= 1.01;

      if (allowed && !checkCollision(p.x, p.y, x, y)) {
        moves.push({x, y, vx, vy});
      }
    }
  }

  selectedMoveIndex = 0;
  return moves;
}

function isInsideTrack(x, y) {
  return x >= 0 && y >= 0 && x < trackWidth && y < trackHeight;
}

function checkCollision(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x1 + dx * i / steps);
    const y = Math.round(y1 + dy * i / steps);
    if (getPixelColor(x, y) === 'wall') return true;
  }
  return false;
}

function checkFinishCrossed(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x1 + dx * i / steps);
    const y = Math.round(y1 + dy * i / steps);
    if (getPixelColor(x, y) === 'finish') return true;
  }
  return false;
}

function drawGrid() {
  ctx.strokeStyle = '#ddd';
  for (let x = 0; x <= trackWidth; x++) {
    ctx.beginPath();
    ctx.moveTo(x * cellSize, 0);
    ctx.lineTo(x * cellSize, trackHeight * cellSize);
    ctx.stroke();
  }
  for (let y = 0; y <= trackHeight; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * cellSize);
    ctx.lineTo(trackWidth * cellSize, y * cellSize);
    ctx.stroke();
  }
}

function drawTrack() {
  for (let y = 0; y < trackHeight; y++) {
    for (let x = 0; x < trackWidth; x++) {
      const i = (y * trackWidth + x) * 4;
      drawCellByColor(
          x, y, trackImageData[i], trackImageData[i + 1],
          trackImageData[i + 2]);
    }
  }
}

function drawCellByColor(x, y, r, g, b) {
  const hex = (r << 16) | (g << 8) | b;
  let fill = null;
  switch (hex) {
    case 0x00ffff:
      fill = 'cyan';
      break;
    case 0xffffff:
      fill = 'white';
      break;
    case 0x7f7f7f:
      fill = 'gray';
      break;
    case 0xffff00:
      fill = 'yellow';
      break;
    case 0x0000ff:
      fill = 'blue';
      break;
    case 0x000000:
      fill = 'black';
      break;
    default:
      return;
  }
  ctx.fillStyle = fill;
  ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
}

function drawTrail() {
  players.forEach((p, i) => {
    if (!p.alive) return;
    const trail = moveTrails[i];
    if (trail.length === 0) return;
    ctx.strokeStyle = p.color;
    ctx.beginPath();
    ctx.moveTo((trail[0].x + 0.5) * cellSize, (trail[0].y + 0.5) * cellSize);
    trail.forEach(
        t => ctx.lineTo((t.x + 0.5) * cellSize, (t.y + 0.5) * cellSize));
    ctx.lineTo((p.x + 0.5) * cellSize, (p.y + 0.5) * cellSize);
    ctx.stroke();
  });
}

function drawPlayers() {
  players.forEach((p, i) => {
    if (!p.alive) return;
    ctx.fillStyle = (i === currentPlayerIndex) ?
        (hoverTarget ? rgba(p.color, 0.5) : p.color) :
        rgba(p.color, 0.4);
    const drawX = hoverTarget && i === currentPlayerIndex ? hoverTarget.x : p.x;
    const drawY = hoverTarget && i === currentPlayerIndex ? hoverTarget.y : p.y;
    ctx.beginPath();
    ctx.arc(
        (drawX + 0.5) * cellSize, (drawY + 0.5) * cellSize, cellSize / 3, 0,
        2 * Math.PI);
    ctx.fill();
  });
}

function drawLegalMoves() {
  const p = players[currentPlayerIndex];
  const playerColor = p.color;
  const validSet = new Set(legalMoves.map(m => `${m.x},${m.y}`));

  for (let ax = -1; ax <= 1; ax++) {
    for (let ay = -1; ay <= 1; ay++) {
      const vx = p.vx + ax, vy = p.vy + ay;
      const x = p.x + vx, y = p.y + vy;
      if (!isInsideTrack(x, y)) continue;

      const key = `${x},${y}`;
      const isValid = validSet.has(key);
      const isSelected = legalMoves[selectedMoveIndex] &&
          legalMoves[selectedMoveIndex].x === x &&
          legalMoves[selectedMoveIndex].y === y;

      ctx.strokeStyle = isSelected ? playerColor :
          isValid                  ? playerColor :
                                     'gray';

      ctx.lineWidth = isSelected ? 3 : 1;
      ctx.setLineDash(isValid ? [] : [3, 3]);
      ctx.strokeRect(x * cellSize, y * cellSize, cellSize, cellSize);
      ctx.setLineDash([]);
    }
  }
}


function drawHoverPreview() {
  if (!hoverTarget) return;

  const p = players[currentPlayerIndex];
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = p.color;
  ctx.beginPath();
  ctx.moveTo((p.x + 0.5) * cellSize, (p.y + 0.5) * cellSize);
  ctx.lineTo(
      (hoverTarget.x + 0.5) * cellSize, (hoverTarget.y + 0.5) * cellSize);
  ctx.stroke();
  ctx.setLineDash([]);
}


function rgba(color, alpha = 1) {
  const COLOR_MAP = {
    red: [255, 0, 0],
    blue: [0, 0, 255],
    green: [0, 128, 0],
    orange: [255, 165, 0]
  };

  const rgb = COLOR_MAP[color] || [0, 0, 0];
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}


function redrawGame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  legalMoves = getLegalMoves();
  drawTrack();
  drawGrid();
  drawTrail();
  drawHoverPreview();
  drawPlayers();
  drawLegalMoves();

  if (players[currentPlayerIndex].alive && legalMoves.length === 0) {
    alert(`Player ${currentPlayerIndex + 1} crashed!`);
    players[currentPlayerIndex].alive = false;
    advanceTurn();
    redrawGame();
  }
}

function advanceTurn() {
  const alive = players.filter(p => p.alive);
  if (alive.length <= 1) return;  // Don't rotate if solo or winner

  do {
    currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
  } while (!players[currentPlayerIndex].alive);
  hoverTarget = null;
}


canvas.addEventListener('mousemove', (e) => {
  const p = players[currentPlayerIndex];
  if (!p || !p.alive) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / cellSize);
  const y = Math.floor((e.clientY - rect.top) / cellSize);
  const match = legalMoves.find(m => m.x === x && m.y === y);
  hoverTarget = match ? {x, y} : null;
  redrawGame();
});

canvas.addEventListener('click', (e) => {
  const p = players[currentPlayerIndex];
  if (!p || !p.alive) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / cellSize);
  const y = Math.floor((e.clientY - rect.top) / cellSize);
  const move = legalMoves.find(m => m.x === x && m.y === y);
  if (move) makeMove(p, move);
});

document.addEventListener('keydown', (e) => {
  if (legalMoves.length === 0) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    selectedMoveIndex = (selectedMoveIndex + 1) % legalMoves.length;
    redrawGame();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    selectedMoveIndex =
        (selectedMoveIndex - 1 + legalMoves.length) % legalMoves.length;
    redrawGame();
  } else if (e.key === 'Enter') {
    const move = legalMoves[selectedMoveIndex];
    if (move) makeMove(players[currentPlayerIndex], move);
  }
});

function makeMove(player, move) {
  moveTrails[currentPlayerIndex].push({x: player.x, y: player.y});
  const prevX = player.x, prevY = player.y;
  player.x = move.x;
  player.y = move.y;
  player.vx = move.vx;
  player.vy = move.vy;
  if (checkFinishCrossed(prevX, prevY, move.x, move.y)) {
    alert(`Player ${currentPlayerIndex + 1} wins!`);
    players.forEach(p => p.alive = false);
  } else {
    advanceTurn();
  }
  redrawGame();
}

function loadTrack(trackName) {
  const image = new Image();
  image.src = `tracks/${trackName}`;
  image.onload = () => {
    const width = image.width, height = image.height;
    canvas.width = width * cellSize;
    canvas.height = height * cellSize;
    trackWidth = width;
    trackHeight = height;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(image, 0, 0);
    trackImageData = tempCtx.getImageData(0, 0, width, height).data;
    setupPlayers();  // auto-start
  };
}

function populateTrackList() {
  fetch('tracks/tracks.json').then(res => res.json()).then(tracks => {
    const select = document.getElementById('trackSelect');
    select.innerHTML = '';
    tracks.forEach(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name.replace('.png', '');
      select.appendChild(option);
    });
    if (tracks.length > 0) loadTrack(tracks[0]);
    select.addEventListener('change', e => {
      loadTrack(e.target.value);
    });
  });
}

function openEditor() {
  window.location.href = 'editor/index.html';
}

window.onload = () => {
  resizeCanvas();
  populateTrackList();
};

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);
