const canvas = document.getElementById('trackCanvas');
const ctx = canvas.getContext('2d');
const cellSize = 20;
let currentTrackData = null;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

function drawGrid(trackWidth, trackHeight) {
  ctx.strokeStyle = '#eee';
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

function drawCellByColor(x, y, r, g, b) {
  const colorHex = (r << 16) | (g << 8) | b;

  let fill = null;
  switch (colorHex) {
    case 0x00ffff:
      fill = 'cyan';
      break;  // Start
    case 0xffffff:
      fill = 'white';
      break;  // Road
    case 0x7f7f7f:
      fill = 'gray';
      break;  // Curb
    case 0xffff00:
      fill = 'yellow';
      break;  // Gravel
    case 0x0000ff:
      fill = 'blue';
      break;  // Wall
    case 0x000000:
      fill = 'black';
      break;  // Finish
    default:
      return;
  }

  ctx.fillStyle = fill;
  ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
}

function loadTrack(trackName) {
  const image = new Image();
  image.src = `tracks/${trackName}`;
  image.onload = () => {
    const width = image.width;
    const height = image.height;

    canvas.width = width * cellSize;
    canvas.height = height * cellSize;

    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;
    const offCtx = offCanvas.getContext('2d');
    offCtx.drawImage(image, 0, 0);

    const imageData = offCtx.getImageData(0, 0, width, height).data;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        const r = imageData[index];
        const g = imageData[index + 1];
        const b = imageData[index + 2];
        drawCellByColor(x, y, r, g, b);
      }
    }

    drawGrid(width, height);  // draw only over track
  };
}

// Load tracks from JSON
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

    // Load first track by default
    if (tracks.length > 0) loadTrack(tracks[0]);

    select.addEventListener('change', e => {
      loadTrack(e.target.value);
    });
  });
}

function openEditor() {
  window.location.href = 'editor/index.html';
}

// Initialize
window.onload = () => {
  resizeCanvas();
  populateTrackList();
};

window.addEventListener('resize', resizeCanvas);
