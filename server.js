const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3500;
const PASSWORD = process.env.FIELDNOTES_PASSWORD || 'changeme';
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Database setup
const db = new Database(path.join(__dirname, 'fieldnotes.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(
  "CREATE TABLE IF NOT EXISTS notes (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))," +
  "updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))," +
  "date TEXT NOT NULL," +
  "time TEXT NOT NULL," +
  "latitude REAL," +
  "longitude REAL," +
  "location_name TEXT," +
  "subject TEXT NOT NULL DEFAULT ''," +
  "camera TEXT NOT NULL DEFAULT ''," +
  "lens TEXT NOT NULL DEFAULT ''," +
  "film_stock TEXT NOT NULL DEFAULT ''," +
  "film_speed TEXT NOT NULL DEFAULT ''," +
  "aperture TEXT NOT NULL DEFAULT ''," +
  "shutter_speed TEXT NOT NULL DEFAULT ''," +
  "holder_sheet TEXT NOT NULL DEFAULT ''," +
  "development TEXT NOT NULL DEFAULT 'Normal'," +
  "filter_factor TEXT," +
  "bellows_extension TEXT," +
  "reciprocity TEXT," +
  "notes TEXT," +
  "synced_to_nextcloud INTEGER NOT NULL DEFAULT 0" +
  ");" +
  "CREATE TABLE IF NOT EXISTS photos (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "note_id INTEGER NOT NULL," +
  "filename TEXT NOT NULL," +
  "original_name TEXT," +
  "created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))," +
  "FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE" +
  ");"
);

// Multer config for photo uploads
var diskStorage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: function(req, file, cb) {
    var ext = path.extname(file.originalname) || '.jpg';
    var name = 'fn_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + ext;
    cb(null, name);
  }
});
var upload = multer({
  storage: diskStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// Static files
app.use('/uploads', express.static(UPLOAD_DIR));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login');
}

// Auth routes
app.get('/login', function(req, res) {
  if (req.session && req.session.authenticated) return res.redirect('/');
  var html = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');
  res.send(html);
});

app.post('/login', function(req, res) {
  if (req.body.password === PASSWORD) {
    req.session.authenticated = true;
    res.redirect('/');
  } else {
    var html = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');
    html = html.replace('<!--ERROR-->', '<div class="error">Invalid password</div>');
    res.send(html);
  }
});

app.get('/logout', function(req, res) {
  req.session.destroy();
  res.redirect('/login');
});

// Main app page
app.get('/', requireAuth, function(req, res) {
  res.sendFile(path.join(__dirname, 'app.html'));
});

// API: List all notes
app.get('/api/notes', requireAuth, function(req, res) {
  var notes = db.prepare(
    "SELECT n.*, " +
    "(SELECT GROUP_CONCAT(p.id || '::' || p.filename, '||') FROM photos p WHERE p.note_id = n.id) as photo_data " +
    "FROM notes n ORDER BY n.date DESC, n.time DESC"
  ).all();

  var result = notes.map(function(n) {
    var photos = [];
    if (n.photo_data) {
      photos = n.photo_data.split('||').map(function(p) {
        var parts = p.split('::');
        return { id: parseInt(parts[0]), filename: parts[1], url: '/uploads/' + parts[1] };
      });
    }
    n.photos = photos;
    delete n.photo_data;
    return n;
  });
  res.json(result);
});

// API: Get single note
app.get('/api/notes/:id', requireAuth, function(req, res) {
  var note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  var photos = db.prepare('SELECT id, filename FROM photos WHERE note_id = ?').all(req.params.id);
  note.photos = photos.map(function(p) {
    return { id: p.id, filename: p.filename, url: '/uploads/' + p.filename };
  });
  res.json(note);
});

// API: Create note
app.post('/api/notes', requireAuth, function(req, res) {
  var b = req.body;
  var stmt = db.prepare(
    "INSERT INTO notes (date, time, latitude, longitude, location_name, subject, camera, lens, " +
    "film_stock, film_speed, aperture, shutter_speed, holder_sheet, development, " +
    "filter_factor, bellows_extension, reciprocity, notes) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  var result = stmt.run(
    b.date, b.time, b.latitude || null, b.longitude || null, b.location_name || null,
    b.subject || '', b.camera || '', b.lens || '', b.film_stock || '', b.film_speed || '',
    b.aperture || '', b.shutter_speed || '', b.holder_sheet || '', b.development || 'Normal',
    b.filter_factor || null, b.bellows_extension || null, b.reciprocity || null, b.notes || null
  );
  res.json({ id: result.lastInsertRowid });
});

// API: Update note
app.put('/api/notes/:id', requireAuth, function(req, res) {
  var b = req.body;
  var stmt = db.prepare(
    "UPDATE notes SET date=?, time=?, latitude=?, longitude=?, location_name=?, subject=?, camera=?, lens=?, " +
    "film_stock=?, film_speed=?, aperture=?, shutter_speed=?, holder_sheet=?, development=?, " +
    "filter_factor=?, bellows_extension=?, reciprocity=?, notes=?, " +
    "updated_at=datetime('now','localtime'), synced_to_nextcloud=0 WHERE id=?"
  );
  stmt.run(
    b.date, b.time, b.latitude || null, b.longitude || null, b.location_name || null,
    b.subject || '', b.camera || '', b.lens || '', b.film_stock || '', b.film_speed || '',
    b.aperture || '', b.shutter_speed || '', b.holder_sheet || '', b.development || 'Normal',
    b.filter_factor || null, b.bellows_extension || null, b.reciprocity || null, b.notes || null,
    req.params.id
  );
  res.json({ success: true });
});

// API: Delete note
app.delete('/api/notes/:id', requireAuth, function(req, res) {
  var photos = db.prepare('SELECT filename FROM photos WHERE note_id = ?').all(req.params.id);
  photos.forEach(function(p) {
    var filepath = path.join(UPLOAD_DIR, p.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  });
  db.prepare('DELETE FROM photos WHERE note_id = ?').run(req.params.id);
  db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// API: Upload photo
app.post('/api/notes/:id/photos', requireAuth, upload.single('photo'), function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  var note = db.prepare('SELECT id FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  var stmt = db.prepare('INSERT INTO photos (note_id, filename, original_name) VALUES (?, ?, ?)');
  var result = stmt.run(req.params.id, req.file.filename, req.file.originalname);
  db.prepare('UPDATE notes SET synced_to_nextcloud = 0 WHERE id = ?').run(req.params.id);

  res.json({
    id: result.lastInsertRowid,
    filename: req.file.filename,
    url: '/uploads/' + req.file.filename
  });
});

// API: Delete photo
app.delete('/api/photos/:id', requireAuth, function(req, res) {
  var photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });

  var filepath = path.join(UPLOAD_DIR, photo.filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

  db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);
  db.prepare('UPDATE notes SET synced_to_nextcloud = 0 WHERE id = ?').run(photo.note_id);
  res.json({ success: true });
});

// API: Duplicate note
app.post('/api/notes/:id/duplicate', requireAuth, function(req, res) {
  var note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });

  var now = new Date();
  var date = now.toISOString().split('T')[0];
  var time = now.toTimeString().split(' ')[0].slice(0, 5);

  var stmt = db.prepare(
    "INSERT INTO notes (date, time, latitude, longitude, location_name, subject, camera, lens, " +
    "film_stock, film_speed, aperture, shutter_speed, holder_sheet, development, " +
    "filter_factor, bellows_extension, reciprocity, notes) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );

  var nextHolder = note.holder_sheet;
  var match = note.holder_sheet.match(/^(\d+)([AB])$/i);
  if (match) {
    var num = parseInt(match[1]);
    var side = match[2].toUpperCase();
    if (side === 'A') nextHolder = num + 'B';
    else nextHolder = (num + 1) + 'A';
  }

  var result = stmt.run(
    date, time, note.latitude, note.longitude, note.location_name,
    note.subject, note.camera, note.lens, note.film_stock, note.film_speed,
    note.aperture, note.shutter_speed, nextHolder, note.development,
    note.filter_factor, note.bellows_extension, note.reciprocity, note.notes
  );
  res.json({ id: result.lastInsertRowid });
});

// ============================================================
// RECIPROCITY CALCULATOR
// ============================================================

var FILM_DATA = {
  // === ILFORD (official p-factors from Ilford tech docs) ===
  'HP5+':       { type: 'power', p: 1.31, name: 'Ilford HP5 Plus 400', threshold: 1 },
  'FP4+':       { type: 'power', p: 1.26, name: 'Ilford FP4 Plus 125', threshold: 1 },
  'Delta 100':  { type: 'power', p: 1.26, name: 'Ilford Delta 100', threshold: 1 },
  'Delta 400':  { type: 'power', p: 1.41, name: 'Ilford Delta 400', threshold: 1 },
  'Delta 3200': { type: 'power', p: 1.33, name: 'Ilford Delta 3200', threshold: 1 },

  // === KODAK B&W ===
  'Tri-X 400':  { type: 'power', p: 1.54, name: 'Kodak Tri-X 400', threshold: 1 },
  'TMAX 100':   { type: 'power', p: 1.15, name: 'Kodak T-Max 100', threshold: 1 },
  'TMAX 400':   { type: 'power', p: 1.24, name: 'Kodak T-Max 400', threshold: 1 },

  // === KODAK COLOR ===
  'Portra 160': { type: 'table', name: 'Kodak Portra 160', threshold: 1,
    points: [[1,1],[2,2.5],[4,6],[8,14],[10,18],[15,32],[30,80],[60,200],[100,400]] },
  'Portra 400': { type: 'table', name: 'Kodak Portra 400', threshold: 1,
    points: [[1,1],[2,2.5],[4,6],[8,14],[10,18],[15,32],[30,80],[60,200],[100,400]] },
  'Ektar 100':  { type: 'table', name: 'Kodak Ektar 100', threshold: 10,
    points: [[1,1],[4,4],[8,8],[10,10],[16,20],[32,40],[64,115],[138,256],[256,563]] },

  // === FOMAPAN (fitted from datasheet / community data) ===
  'Fomapan 100': { type: 'gainer', a: 1.5, b: 1.62, name: 'Fomapan 100 Classic', threshold: 1 },
  'Fomapan 200': { type: 'gainer', a: 1.07, b: 1.44, name: 'Fomapan 200 Creative', threshold: 1 },
  'Fomapan 400': { type: 'table', name: 'Fomapan 400 Action', threshold: 1,
    points: [[1,1.5],[2,3],[4,6],[8,12],[10,15],[30,45],[60,90],[100,150]] },

  // === FUJI ===
  'Acros 100 II': { type: 'acros', name: 'Fuji Neopan Acros 100 II', threshold: 120 },

  // === CINESTILL ===
  'CineStill 800T': { type: 'table', name: 'CineStill 800T', threshold: 1,
    points: [[1,1.5],[2,3.5],[4,8],[8,18],[10,25],[15,40],[30,100],[60,250]] }
};

function calculateReciprocity(filmKey, meteredSeconds) {
  var film = FILM_DATA[filmKey];
  if (!film) return null;

  var tm = parseFloat(meteredSeconds);
  if (isNaN(tm) || tm <= 0) return null;

  var tc;

  if (tm < film.threshold) {
    tc = tm;
  } else if (film.type === 'power') {
    tc = Math.pow(tm, film.p);
  } else if (film.type === 'gainer') {
    tc = tm + film.a * Math.pow(tm, film.b);
  } else if (film.type === 'acros') {
    if (tm <= 120) {
      tc = tm;
    } else {
      tc = tm * 1.41; // +0.5 stop beyond 120s
    }
  } else if (film.type === 'table') {
    tc = interpolateTable(film.points, tm);
  } else {
    tc = tm;
  }

  var stopsAdded = tc > tm ? Math.log2(tc / tm) : 0;

  return {
    film: film.name,
    film_key: filmKey,
    metered_seconds: tm,
    adjusted_seconds: Math.round(tc * 10) / 10,
    metered_display: formatTime(tm),
    adjusted_display: formatTime(Math.round(tc * 10) / 10),
    stops_added: Math.round(stopsAdded * 10) / 10,
    formula_type: film.type,
    note: tc === tm ? 'No compensation needed' : null
  };
}

function interpolateTable(points, tm) {
  if (tm <= points[0][0]) return points[0][1];
  if (tm >= points[points.length - 1][0]) {
    var last = points[points.length - 1];
    var prev = points[points.length - 2];
    var slope = Math.log(last[1] / prev[1]) / Math.log(last[0] / prev[0]);
    return last[1] * Math.pow(tm / last[0], slope);
  }
  for (var i = 0; i < points.length - 1; i++) {
    if (tm >= points[i][0] && tm <= points[i + 1][0]) {
      var x0 = Math.log(points[i][0]);
      var x1 = Math.log(points[i + 1][0]);
      var y0 = Math.log(points[i][1]);
      var y1 = Math.log(points[i + 1][1]);
      var t = (Math.log(tm) - x0) / (x1 - x0);
      return Math.exp(y0 + t * (y1 - y0));
    }
  }
  return tm;
}

function formatTime(seconds) {
  if (seconds < 60) {
    return seconds + 's';
  } else if (seconds < 3600) {
    var m = Math.floor(seconds / 60);
    var s = Math.round(seconds % 60);
    return s > 0 ? m + 'm ' + s + 's' : m + 'm';
  } else {
    var h = Math.floor(seconds / 3600);
    var rem = Math.round(seconds % 3600);
    var mi = Math.floor(rem / 60);
    return mi > 0 ? h + 'h ' + mi + 'm' : h + 'h';
  }
}

// API: GET /api/reciprocity?film=HP5+&time=10
app.get('/api/reciprocity', requireAuth, function(req, res) {
  var filmKey = req.query.film;
  var meteredTime = req.query.time;

  if (!filmKey && !meteredTime) {
    var films = Object.keys(FILM_DATA).map(function(key) {
      return { key: key, name: FILM_DATA[key].name, type: FILM_DATA[key].type };
    });
    return res.json({ films: films });
  }

  if (!filmKey || !meteredTime) {
    return res.status(400).json({ error: 'Both film and time parameters required' });
  }

  var result = calculateReciprocity(filmKey, meteredTime);
  if (!result) {
    return res.status(400).json({ error: 'Invalid film stock or time value' });
  }

  res.json(result);
});

// API: POST /api/reciprocity/batch
app.post('/api/reciprocity/batch', requireAuth, function(req, res) {
  var meteredTime = req.body.time;
  if (!meteredTime) return res.status(400).json({ error: 'time required' });

  var results = {};
  Object.keys(FILM_DATA).forEach(function(key) {
    results[key] = calculateReciprocity(key, meteredTime);
  });

  res.json(results);
});

// ============================================================
// NEXTCLOUD SYNC
// ============================================================

app.post('/api/sync', requireAuth, async function(req, res) {
  try {
    var unsynced = db.prepare(
      "SELECT n.*, " +
      "(SELECT GROUP_CONCAT(p.filename, '||') FROM photos p WHERE p.note_id = n.id) as photo_files " +
      "FROM notes n WHERE n.synced_to_nextcloud = 0"
    ).all();

    if (unsynced.length === 0) return res.json({ message: 'All notes synced', count: 0 });

    var NC_URL = process.env.NEXTCLOUD_URL || 'https://nextcloud.aeoui.xyz';
    var NC_USER = process.env.NEXTCLOUD_USER || 'admin';
    var NC_PASS = process.env.NEXTCLOUD_PASSWORD || '';
    var NC_BASE_PATH = '/remote.php/dav/files/' + NC_USER + '/Fieldnotes';
    var authHeader = 'Basic ' + Buffer.from(NC_USER + ':' + NC_PASS).toString('base64');

    var syncCount = 0;
    for (var i = 0; i < unsynced.length; i++) {
      var note = unsynced[i];
      var safeName = (note.subject || 'untitled').replace(/[^a-zA-Z0-9_ -]/g, '').trim().slice(0, 50);
      var folderName = note.date + ' ' + safeName;
      var encodedFolderName = encodeURIComponent(folderName);
      var noteFolder = NC_URL + NC_BASE_PATH + '/' + encodedFolderName;

      // Create note subfolder
      await fetch(noteFolder, {
        method: 'MKCOL',
        headers: { 'Authorization': authHeader }
      }).catch(function() {});

      // Write markdown inside the subfolder
      var md = generateMarkdown(note, folderName);
      var putRes = await fetch(noteFolder + '/' + encodedFolderName + '.md', {
        method: 'PUT',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'text/markdown'
        },
        body: md
      });

      if (!putRes.ok) {
        console.error('Failed to sync note ' + note.id + ': ' + putRes.status + ' ' + putRes.statusText);
        continue;
      }

      // Upload photos into the same subfolder with clean names
      if (note.photo_files) {
        var files = note.photo_files.split('||');
        for (var j = 0; j < files.length; j++) {
          var filename = files[j];
          var filepath = path.join(UPLOAD_DIR, filename);
          if (fs.existsSync(filepath)) {
            var fileData = fs.readFileSync(filepath);
            var origExt = path.extname(filename).toLowerCase() || '.jpg';
            var mimeType = origExt === '.png' ? 'image/png' : origExt === '.heic' ? 'image/heic' : 'image/jpeg';
            var cleanName = folderName.replace(/ /g, '_') + '_' + String(j + 1).padStart(2, '0') + origExt;
            await fetch(noteFolder + '/' + encodeURIComponent(cleanName), {
              method: 'PUT',
              headers: {
                'Authorization': authHeader,
                'Content-Type': mimeType
              },
              body: fileData
            });
          }
        }
      }

      db.prepare('UPDATE notes SET synced_to_nextcloud = 1 WHERE id = ?').run(note.id);
      syncCount++;
    }

    res.json({ message: 'Synced ' + syncCount + ' notes to Nextcloud', count: syncCount });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

function generateMarkdown(note, folderName) {
  var photos = note.photo_files ? note.photo_files.split('||') : [];
  var mapLink = null;
  if (note.latitude && note.longitude) {
    mapLink = 'https://www.openstreetmap.org/?mlat=' + note.latitude + '&mlon=' + note.longitude +
      '#map=15/' + note.latitude + '/' + note.longitude;
  }

  var md = '# ' + (note.subject || 'Untitled') + '\n\n';
  md += '**Date:** ' + note.date + '  \n';
  md += '**Time:** ' + note.time + '  \n';
  if (note.location_name) md += '**Location:** ' + note.location_name + '  \n';
  if (mapLink) md += '**Map:** [View on OpenStreetMap](' + mapLink + ')  \n';
  if (note.latitude && note.longitude) {
    md += '**Coordinates:** ' + note.latitude.toFixed(6) + ', ' + note.longitude.toFixed(6) + '  \n';
  }
  md += '\n---\n\n';
  md += '## Exposure\n\n';
  md += '| Setting | Value |\n|---------|-------|\n';
  md += '| Camera | ' + note.camera + ' |\n';
  md += '| Lens | ' + note.lens + ' |\n';
  md += '| Film | ' + note.film_stock + ' |\n';
  md += '| ISO | ' + note.film_speed + ' |\n';
  md += '| Aperture | ' + note.aperture + ' |\n';
  md += '| Shutter | ' + note.shutter_speed + ' |\n';
  md += '| Holder/Sheet | ' + note.holder_sheet + ' |\n';
  md += '| Development | ' + note.development + ' |\n';
  if (note.filter_factor) md += '| Filter | ' + note.filter_factor + ' |\n';
  if (note.bellows_extension) md += '| Bellows Ext. | ' + note.bellows_extension + ' |\n';
  if (note.reciprocity) md += '| Reciprocity | ' + note.reciprocity + ' |\n';
  if (note.notes) {
    md += '\n---\n\n## Notes\n\n' + note.notes + '\n';
  }
  if (photos.length > 0) {
    md += '\n---\n\n## Photos\n\n';
    photos.forEach(function(f, idx) {
      var origExt = f.substring(f.lastIndexOf('.')) || '.jpg';
      var cleanName = folderName.replace(/ /g, '_') + '_' + String(idx + 1).padStart(2, '0') + origExt;
      md += '![' + cleanName + '](' + cleanName + ')\n\n';
    });
  }
  return md;
}

app.listen(PORT, '127.0.0.1', function() {
  console.log('Field Notes running on port ' + PORT);
});
