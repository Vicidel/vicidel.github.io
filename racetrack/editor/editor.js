const canvas = document.getElementById('editorCanvas');
const ctx = canvas.getContext('2d');
const cellSize = 20;

const COLORS = {
  road: [255, 255, 255],
  wall: [0, 0, 255],
  start: [0, 255, 255],
  finish: [0, 0, 0],
  gravel: [255, 255, 0],
  curb: [127, 127, 127]
};

let currentColor = 'road';
let grid = [];
let cols = 40;
let rows = 30;

function triggerFileInput() {
  document.getElementById('fileInput').click();
}
document.getElementById('fileInput').addEventListener('change', loadFromFile);

function loadFromFile() {
  const input = document.getElementById('fileInput');
  if (!input.files.length) return;

  const file = input.files[0];
  const reader = new FileReader();

  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const offCanvas = document.createElement('canvas');
      offCanvas.width = img.width;
      offCanvas.height = img.height;
      const offCtx = offCanvas.getContext('2d');
      offCtx.drawImage(img, 0, 0);

      const imageData = offCtx.getImageData(0, 0, img.width, img.height).data;
      cols = img.width;
      rows = img.height;
      canvas.width = cols * cellSize;
      canvas.height = rows * cellSize;

      grid = Array.from({length: rows}, () => Array(cols).fill('wall'));

      const rgbToKey = (r, g, b) => {
        for (let key in COLORS) {
          const [cr, cg, cb] = COLORS[key];
          if (r === cr && g === cg && b === cb) return key;
        }
        return 'wall';  // default fallback
      };

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = (y * cols + x) * 4;
          const r = imageData[i];
          const g = imageData[i + 1];
          const b = imageData[i + 2];
          grid[y][x] = rgbToKey(r, g, b);
        }
      }

      drawPalette();
      drawGrid();
    };

    img.src = e.target.result;
  };

  reader.readAsDataURL(file);
}


function resetGrid() {
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      grid[y][x] = 'wall';
    }
  }
  drawGrid();
}

function initGridEditor(width, height) {
  cols = width;
  rows = height;
  canvas.width = cols * cellSize;
  canvas.height = rows * cellSize;

  grid = Array.from({length: rows}, () => Array(cols).fill('wall'));

  drawPalette();
  drawGrid();
}

function drawPalette() {
  const paletteDiv = document.getElementById('palette');
  paletteDiv.innerHTML = '';  // Clear existing

  for (let key in COLORS) {
    const div = document.createElement('div');
    div.classList.add('palette-color');
    if (key === currentColor) div.classList.add('selected');
    div.dataset.color = key;

    const box = document.createElement('div');
    box.classList.add('palette-color-box');
    box.style.backgroundColor = `rgb(${COLORS[key].join(',')})`;

    div.appendChild(box);
    div.appendChild(document.createTextNode(key));

    div.onclick = () => {
      document.querySelectorAll('.palette-color')
          .forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      currentColor = key;
    };

    paletteDiv.appendChild(div);
  }
}

function goBackToGame() {
  window.location.href = '../index.html';
}

function drawGrid() {
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const color = COLORS[grid[y][x]];
      ctx.fillStyle = `rgb(${color.join(',')})`;
      ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      ctx.strokeStyle = '#ccc';
      ctx.strokeRect(x * cellSize, y * cellSize, cellSize, cellSize);
    }
  }
}

let isDrawing = false;

function drawCellAtMouse(e) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / cellSize);
  const y = Math.floor((e.clientY - rect.top) / cellSize);
  if (x >= 0 && x < cols && y >= 0 && y < rows) {
    grid[y][x] = currentColor;
    drawGrid();
  }
}

canvas.addEventListener('mousedown', (e) => {
  isDrawing = true;
  drawCellAtMouse(e);
});

canvas.addEventListener('mousemove', (e) => {
  if (isDrawing) {
    drawCellAtMouse(e);
  }
});

canvas.addEventListener('mouseup', () => {
  isDrawing = false;
});

canvas.addEventListener('mouseleave', () => {
  isDrawing = false;
});

function exportImage() {
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = cols;
  exportCanvas.height = rows;
  const exportCtx = exportCanvas.getContext('2d');

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const [r, g, b] = COLORS[grid[y][x]];
      exportCtx.fillStyle = `rgb(${r},${g},${b})`;
      exportCtx.fillRect(x, y, 1, 1);
    }
  }

  const link = document.createElement('a');
  link.download = 'track.png';
  link.href = exportCanvas.toDataURL();
  link.click();
}

// Form to set canvas/grid size
document.getElementById('sizeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const width = parseInt(document.getElementById('colsInput').value);
  const height = parseInt(document.getElementById('rowsInput').value);
  if (width > 0 && height > 0) {
    initGridEditor(width, height);
  }
});

// Start default grid on load
window.onload = () => {
  initGridEditor(40, 30);
};
