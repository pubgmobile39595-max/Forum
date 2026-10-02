const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { marked } = require('marked');

const app = express();
const db = new sqlite3.Database('./forum.db');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'file_' + Date.now() + '_' + Math.floor(Math.random()*1000) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 3 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ secret: 'gizli-anahtar-2025', resave: false, saveUninitialized: true }));

db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password TEXT,
  email TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  role TEXT DEFAULT 'user',
  banned INTEGER DEFAULT 0,
  points INTEGER DEFAULT 0,
  last_login TEXT DEFAULT '',
  created_at TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  content TEXT,
  author TEXT,
  category TEXT DEFAULT 'Genel',
  tags TEXT DEFAULT '',
  likes INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  locked INTEGER DEFAULT 0,
  edited INTEGER DEFAULT 0,
  date TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  author TEXT,
  content TEXT,
  quote_id INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  edited INTEGER DEFAULT 0,
  date TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  username TEXT,
  UNIQUE(post_id, username)
)`);

db.run(`CREATE TABLE IF NOT EXISTS comment_likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER,
  username TEXT,
  UNIQUE(comment_id, username)
)`);

db.run(`CREATE TABLE IF NOT EXISTS follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  follower TEXT,
  following TEXT,
  UNIQUE(follower, following)
)`);

db.run(`CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  message TEXT,
  link TEXT,
  is_read INTEGER DEFAULT 0,
  date TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  username TEXT,
  UNIQUE(post_id, username)
)`);

db.run(`CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  question TEXT,
  options TEXT,
  votes TEXT DEFAULT ''
)`);

db.run(`CREATE TABLE IF NOT EXISTS poll_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER,
  username TEXT,
  option_index INTEGER,
  UNIQUE(poll_id, username)
)`);

db.run(`CREATE TABLE IF NOT EXISTS badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  badge TEXT,
  date TEXT,
  UNIQUE(username, badge)
)`);

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  db.get('SELECT * FROM users WHERE username=? AND banned=0', [req.session.user], (err, u) => {
    if (!u) { req.session.destroy(); return res.redirect('/'); }
    req.userData = u;
    next();
  });
}

function requireAdmin(req, res, next) {
  db.get('SELECT role FROM users WHERE username=?', [req.session.user], (err, u) => {
    if (!u || (u.role !== 'admin' && u.role !== 'mod')) return res.send('Yetkisiz! <a href="/">Geri</a>');
    next();
  });
}

function notify(username, message, link) {
  if (!username) return;
  db.run('INSERT INTO notifications (username, message, link, date) VALUES (?, ?, ?, ?)',
    [username, message, link, new Date().toLocaleString('tr-TR')]);
}

function addPoints(username, amount) {
  if (!username || amount === 0) return;
  db.run('UPDATE users SET points = points + ? WHERE username=?', [amount, username], () => {
    checkBadges(username);
  });
}

function checkBadges(username) {
  db.get('SELECT points FROM users WHERE username=?', [username], (e, u) => {
    if (!u) return;
    const p = u.points;
    let badge = null;
    if (p >= 1000) badge = 'efsane';
    else if (p >= 500) badge = 'usta';
    else if (p >= 100) badge = 'aktif';
    else if (p >= 10) badge = 'yeni';
    if (badge) {
      db.run('INSERT OR IGNORE INTO badges (username, badge, date) VALUES (?, ?, ?)',
        [username, badge, new Date().toLocaleString('tr-TR')]);
    }
  });
}

function extractMentions(text) {
  const matches = text.match(/@(\w+)/g) || [];
  return [...new Set(matches.map(m => m.substring(1)))];
}

function parseTags(str) {
  return (str || '').split(',').map(t => t.trim().replace(/^#/, '')).filter(t => t).join(',');
}

function renderMarkdown(text) {
  try {
    return marked.parse(text || '', { breaks: true });
  } catch (e) {
    return text || '';
  }
}

app.use((req, res, next) => {
  res.locals.user = req.session.user;
  res.locals.isAdmin = false;
  res.locals.notifCount = 0;
  res.locals.avatar = '';
  res.locals.points = 0;
  res.locals.badges = [];
  if (req.session.user) {
    db.get('SELECT role, avatar, points FROM users WHERE username=?', [req.session.user], (e, u) => {
      if (u) {
        res.locals.isAdmin = (u.role === 'admin' || u.role === 'mod');
        res.locals.avatar = u.avatar;
        res.locals.points = u.points;
      }
      db.all('SELECT badge FROM badges WHERE username=?', [req.session.user], (e2, bs) => {
        res.locals.badges = (bs || []).map(b => b.badge);
        db.get('SELECT COUNT(*) as c FROM notifications WHERE username=? AND is_read=0',
          [req.session.user], (er, r) => {
            res.locals.notifCount = r ? r.c : 0;
            next();
          });
      });
    });
  } else next();
});

app.get('/api/welcome-stats', (req, res) => {
  db.get('SELECT COUNT(*) as c FROM users', (e1, u) => {
    db.get('SELECT COUNT(*) as c FROM posts', (e2, p) => {
      db.get('SELECT COUNT(*) as c FROM comments', (e3, cm) => {
        res.json({ users: u.c, posts: p.c, comments: cm.c });
      });
    });
  });
});

app.get('/', (req, res) => {
  if (!req.session.user) {
    return res.render('welcome', { user: null, isAdmin: false, notifCount: 0, error: req.query.error || '' });
  }
  const search = req.query.q || '';
  const category = req.query.cat || '';
  const tag = req.query.tag || '';
  const sort = req.query.sort || 'new';
  const page = parseInt(req.query.page) || 1;
  const perPage = 10;
  const offset = (page - 1) * perPage;

  let sql = 'SELECT * FROM posts WHERE 1=1';
  const params = [];
  if (search) { sql += ' AND (title LIKE ? OR content LIKE ?)'; params.push('%'+search+'%', '%'+search+'%'); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (tag) { sql += ' AND tags LIKE ?'; params.push('%'+tag+'%'); }

  if (sort === 'popular') sql += ' ORDER BY pinned DESC, likes DESC, id DESC';
  else if (sort === 'views') sql += ' ORDER BY pinned DESC, views DESC, id DESC';
  else sql += ' ORDER BY pinned DESC, id DESC';
  sql += ' LIMIT ? OFFSET ?';
  params.push(perPage, offset);

  let countSql = 'SELECT COUNT(*) as c FROM posts WHERE 1=1';
  const countParams = [];
  if (search) { countSql += ' AND (title LIKE ? OR content LIKE ?)'; countParams.push('%'+search+'%', '%'+search+'%'); }
  if (category) { countSql += ' AND category = ?'; countParams.push(category); }
  if (tag) { countSql += ' AND tags LIKE ?'; countParams.push('%'+tag+'%'); }

  db.get(countSql, countParams, (e, total) => {
    db.all(sql, params, (err, posts) => {
      db.all('SELECT DISTINCT category FROM posts', (e2, cats) => {
        db.all('SELECT tags FROM posts WHERE tags != ""', (e3, tagRows) => {
          const allTags = [];
          (tagRows || []).forEach(r => r.tags.split(',').forEach(t => {
            if (t && !allTags.includes(t)) allTags.push(t);
          }));
          const totalPages = Math.ceil((total ? total.c : 0) / perPage);
          res.render('index', {
            posts: posts || [], categories: cats || [], allTags: allTags.slice(0, 20),
            user: req.session.user, isAdmin: res.locals.isAdmin,
            notifCount: res.locals.notifCount,
            search, activeCategory: category, activeTag: tag, sort, page, totalPages
          });
        });
      });
    });
  });
});

app.post('/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) return res.send('Eksik bilgi! <a href="/">Geri</a>');
  if (username.length < 3) return res.send('Kullanici adi en az 3 karakter! <a href="/">Geri</a>');
  if (password.length < 4) return res.send('Sifre en az 4 karakter! <a href="/">Geri</a>');
  const hash = await bcrypt.hash(password, 10);
  db.get('SELECT COUNT(*) as c FROM users', (e, x) => {
    const role = (x && x.c === 0) ? 'admin' : 'user';
    db.run('INSERT INTO users (username, password, email, role, points, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [username, hash, email || '', role, 0, new Date().toLocaleString('tr-TR')], (err) => {
        if (err) return res.send('Kullanici zaten var! <a href="/">Geri</a>');
        req.session.user = username;
        res.redirect('/');
      });
  });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username=?', [username], async (err, user) => {
    if (!user) return res.send('Kullanici bulunamadi! <a href="/">Geri</a>');
    if (user.banned) return res.send('Hesabiniz yasaklandi! <a href="/">Geri</a>');
    const ok = await bcrypt.compare(password, user.password);
    if (ok) {
      req.session.user = user.username;
      const today = new Date().toDateString();
      const lastDate = user.last_login ? new Date(user.last_login).toDateString() : '';
      if (lastDate !== today) {
        addPoints(user.username, 2);
        db.run('UPDATE users SET last_login=? WHERE username=?',
          [new Date().toLocaleString('tr-TR'), user.username]);
      }
    }
    res.redirect('/');
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.post('/post', requireLogin, upload.single('attachment'), (req, res) => {
  const { title, content, category, tags, poll_question, poll_options } = req.body;
  const cleanTags = parseTags(tags);
  const attachment = req.file ? '/uploads/' + req.file.filename : '';
  let fullContent = content;
  if (attachment) {
    const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(attachment);
    fullContent += '\n\n' + (isImage ? '![gorsel](' + attachment + ')' : '[Dosya](' + attachment + ')');
  }
  db.run('INSERT INTO posts (title, content, author, category, tags, date) VALUES (?, ?, ?, ?, ?, ?)',
    [title, fullContent, req.session.user, category || 'Genel', cleanTags, new Date().toLocaleString('tr-TR')],
    function() {
      const postId = this.lastID;
      addPoints(req.session.user, 10);
      if (poll_question && poll_options) {
        const opts = poll_options.split('\n').map(o => o.trim()).filter(o => o);
        if (opts.length >= 2) {
          db.run('INSERT INTO polls (post_id, question, options, votes) VALUES (?, ?, ?, ?)',
            [postId, poll_question, JSON.stringify(opts), '']);
        }
      }
      const mentions = extractMentions(content);
      mentions.forEach(m => {
        db.get('SELECT username FROM users WHERE username=?', [m], (e, u) => {
          if (u && u.username !== req.session.user) {
            notify(u.username, 'Konuda etiketlendiniz: ' + req.session.user, '/post/' + postId);
          }
        });
      });
      res.redirect('/post/' + postId);
    });
});

app.get('/post/:id', (req, res) => {
  db.run('UPDATE posts SET views = views + 1 WHERE id=?', [req.params.id]);
  db.get('SELECT * FROM posts WHERE id=?', [req.params.id], (err, post) => {
    if (!post) return res.redirect('/');
    post.content_html = renderMarkdown(post.content);
    db.all('SELECT * FROM comments WHERE post_id=? ORDER BY id ASC', [req.params.id], (e, comments) => {
      comments = (comments || []).map(c => Object.assign({}, c, { content_html: renderMarkdown(c.content) }));
      db.all('SELECT comment_id FROM comment_likes WHERE username=?',
        [req.session.user || ''], (e2, likedComments) => {
          const likedIds = (likedComments || []).map(x => x.comment_id);
          db.get('SELECT * FROM polls WHERE post_id=?', [req.params.id], (e3, poll) => {
            const renderPage = (liked, pollData, isBookmarked) => {
              db.get('SELECT * FROM users WHERE username=?', [post.author], (er, authorData) => {
                res.render('post', {
                  post, comments, user: req.session.user,
                  isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount,
                  liked: !!liked, likedIds, authorData: authorData || {},
                  pollData: pollData, isBookmarked: !!isBookmarked
                });
              });
            };
            const checkBookmark = (liked, pollData) => {
              db.get('SELECT * FROM bookmarks WHERE post_id=? AND username=?',
                [req.params.id, req.session.user || ''], (e5, bm) => {
                  renderPage(liked, pollData, bm);
                });
            };
            const checkLike = (pollData) => {
              if (req.session.user) {
                db.get('SELECT * FROM likes WHERE post_id=? AND username=?',
                  [req.params.id, req.session.user], (er2, row) => {
                    checkBookmark(row, pollData);
                  });
              } else checkBookmark(null, pollData);
            };
            if (poll) {
              const pollData = {
                id: poll.id,
                question: poll.question,
                options: JSON.parse(poll.options || '[]'),
                votes: JSON.parse(poll.votes || '{}')
              };
              db.all('SELECT * FROM poll_votes WHERE poll_id=?', [poll.id], (e4, votes) => {
                pollData.voteCounts = {};
                (votes || []).forEach(v => {
                  pollData.voteCounts[v.option_index] = (pollData.voteCounts[v.option_index] || 0) + 1;
                });
                pollData.totalVotes = (votes || []).length;
                pollData.userVote = -1;
                if (req.session.user) {
                  const userVote = (votes || []).find(v => v.username === req.session.user);
                  if (userVote) pollData.userVote = userVote.option_index;
                }
                checkLike(pollData);
              });
            } else checkLike(null);
          });
        });
    });
  });
});

app.post('/poll/:id/vote', requireLogin, (req, res) => {
  const pollId = req.params.id;
  const optionIndex = parseInt(req.body.option);
  db.get('SELECT * FROM polls WHERE id=?', [pollId], (e, poll) => {
    if (!poll) return res.redirect('back');
    db.get('SELECT * FROM poll_votes WHERE poll_id=? AND username=?', [pollId, req.session.user], (e2, existing) => {
      if (existing) return res.redirect('/post/' + poll.post_id);
      db.run('INSERT INTO poll_votes (poll_id, username, option_index) VALUES (?, ?, ?)',
        [pollId, req.session.user, optionIndex], () => {
          addPoints(req.session.user, 1);
          res.redirect('/post/' + poll.post_id);
        });
    });
  });
});

app.get('/post/:id/edit', requireLogin, (req, res) => {
  db.get('SELECT * FROM posts WHERE id=?', [req.params.id], (err, post) => {
    if (!post) return res.redirect('/');
    if (post.author !== req.session.user && !res.locals.isAdmin) return res.redirect('/post/' + post.id);
    res.render('edit-post', { post, user: req.session.user, isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount });
  });
});

app.post('/post/:id/edit', requireLogin, (req, res) => {
  const { title, content, category, tags } = req.body;
  const cleanTags = parseTags(tags);
  db.get('SELECT * FROM posts WHERE id=?', [req.params.id], (err, post) => {
    if (!post) return res.redirect('/');
    if (post.author !== req.session.user && !res.locals.isAdmin) return res.redirect('/post/' + post.id);
    db.run('UPDATE posts SET title=?, content=?, category=?, tags=?, edited=1 WHERE id=?',
      [title, content, category, cleanTags, req.params.id], () => res.redirect('/post/' + req.params.id));
  });
});

app.post('/delete/:id', requireLogin, (req, res) => {
  db.get('SELECT * FROM posts WHERE id=?', [req.params.id], (err, post) => {
    if (!post) return res.redirect('/');
    if (post.author !== req.session.user && !res.locals.isAdmin) return res.redirect('/');
    db.run('DELETE FROM posts WHERE id=?', [req.params.id], () => {
      db.run('DELETE FROM comments WHERE post_id=?', [req.params.id], () => {
        db.run('DELETE FROM likes WHERE post_id=?', [req.params.id], () => {
          db.run('DELETE FROM polls WHERE post_id=?', [req.params.id], () => res.redirect('/'));
        });
      });
    });
  });
});

app.post('/pin/:id', requireLogin, requireAdmin, (req, res) => {
  db.get('SELECT pinned FROM posts WHERE id=?', [req.params.id], (e, p) => {
    if (!p) return res.redirect('/');
    db.run('UPDATE posts SET pinned=? WHERE id=?', [p.pinned ? 0 : 1, req.params.id], () => res.redirect('back'));
  });
});

app.post('/lock/:id', requireLogin, requireAdmin, (req, res) => {
  db.get('SELECT locked FROM posts WHERE id=?', [req.params.id], (e, p) => {
    if (!p) return res.redirect('/');
    db.run('UPDATE posts SET locked=? WHERE id=?', [p.locked ? 0 : 1, req.params.id], () => res.redirect('back'));
  });
});

app.post('/comment/:id', requireLogin, (req, res) => {
  const { content, quote_id } = req.body;
  db.get('SELECT * FROM posts WHERE id=?', [req.params.id], (e, post) => {
    if (!post || post.locked) return res.redirect('/post/' + req.params.id);
    db.run('INSERT INTO comments (post_id, author, content, quote_id, date) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, req.session.user, content, quote_id || 0, new Date().toLocaleString('tr-TR')],
      (err) => {
        addPoints(req.session.user, 5);
        if (post.author !== req.session.user) {
          notify(post.author, req.session.user + ' konunuza yorum yapti', '/post/' + post.id);
        }
        const mentions = extractMentions(content);
        mentions.forEach(m => {
          db.get('SELECT username FROM users WHERE username=?', [m], (e2, u) => {
            if (u && u.username !== req.session.user) {
              notify(u.username, req.session.user + ' sizi bir yorumda etiketledi', '/post/' + post.id);
            }
          });
        });
        res.redirect('/post/' + req.params.id);
      });
  });
});

app.post('/comment/:id/delete', requireLogin, (req, res) => {
  db.get('SELECT * FROM comments WHERE id=?', [req.params.id], (e, c) => {
    if (!c) return res.redirect('/');
    if (c.author !== req.session.user && !res.locals.isAdmin) return res.redirect('/post/' + c.post_id);
    db.run('DELETE FROM comments WHERE id=?', [req.params.id], () => res.redirect('/post/' + c.post_id));
  });
});

app.post('/like/:id', requireLogin, (req, res) => {
  const pid = req.params.id;
  db.get('SELECT * FROM likes WHERE post_id=? AND username=?', [pid, req.session.user], (err, row) => {
    if (row) {
      db.run('DELETE FROM likes WHERE post_id=? AND username=?', [pid, req.session.user], () => {
        db.run('UPDATE posts SET likes = likes - 1 WHERE id=?', [pid], () => res.redirect('back'));
      });
    } else {
      db.run('INSERT INTO likes (post_id, username) VALUES (?, ?)', [pid, req.session.user], () => {
        db.run('UPDATE posts SET likes = likes + 1 WHERE id=?', [pid], () => {
          db.get('SELECT author FROM posts WHERE id=?', [pid], (e, p) => {
            if (p && p.author !== req.session.user) {
              notify(p.author, req.session.user + ' konunuzu begendi', '/post/' + pid);
              addPoints(p.author, 2);
            }
          });
          res.redirect('back');
        });
      });
    }
  });
});

app.post('/comment-like/:id', requireLogin, (req, res) => {
  const cid = req.params.id;
  db.get('SELECT * FROM comment_likes WHERE comment_id=? AND username=?', [cid, req.session.user], (err, row) => {
    if (row) {
      db.run('DELETE FROM comment_likes WHERE comment_id=? AND username=?', [cid, req.session.user], () => {
        db.run('UPDATE comments SET likes = likes - 1 WHERE id=?', [cid], () => res.redirect('back'));
      });
    } else {
      db.run('INSERT INTO comment_likes (comment_id, username) VALUES (?, ?)', [cid, req.session.user], () => {
        db.run('UPDATE comments SET likes = likes + 1 WHERE id=?', [cid], () => res.redirect('back'));
      });
    }
  });
});

app.post('/bookmark/:id', requireLogin, (req, res) => {
  const pid = req.params.id;
  db.get('SELECT * FROM bookmarks WHERE post_id=? AND username=?', [pid, req.session.user], (e, row) => {
    if (row) {
      db.run('DELETE FROM bookmarks WHERE post_id=? AND username=?', [pid, req.session.user], () => res.redirect('back'));
    } else {
      db.run('INSERT INTO bookmarks (post_id, username) VALUES (?, ?)', [pid, req.session.user], () => res.redirect('back'));
    }
  });
});

app.get('/bookmarks', requireLogin, (req, res) => {
  db.all('SELECT p.* FROM posts p INNER JOIN bookmarks b ON p.id = b.post_id WHERE b.username=? ORDER BY p.id DESC',
    [req.session.user], (e, posts) => {
      res.render('bookmarks', {
        posts: posts || [], user: req.session.user,
        isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
      });
    });
});

app.get('/leaderboard', (req, res) => {
  db.all('SELECT username, avatar, points FROM users WHERE banned=0 ORDER BY points DESC LIMIT 50',
    (e, users) => {
      res.render('leaderboard', {
        users: users || [], user: req.session.user,
        isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
      });
    });
});

app.get('/profile/:username', (req, res) => {
  const u = req.params.username;
  db.get('SELECT * FROM users WHERE username=?', [u], (err, userData) => {
    if (!userData) return res.redirect('/');
    db.all('SELECT * FROM posts WHERE author=? ORDER BY id DESC', [u], (e, posts) => {
      db.get('SELECT COUNT(*) as c FROM comments WHERE author=?', [u], (er, cc) => {
        db.get('SELECT COUNT(*) as c FROM follows WHERE following=?', [u], (er2, fc) => {
          db.get('SELECT COUNT(*) as c FROM follows WHERE follower=?', [u], (er3, fg) => {
            db.all('SELECT badge FROM badges WHERE username=?', [u], (er4, badges) => {
              const finish = (isFollowing) => res.render('profile', {
                profile: userData, posts: posts || [],
                commentCount: cc ? cc.c : 0,
                followerCount: fc ? fc.c : 0,
                followingCount: fg ? fg.c : 0,
                badges: (badges || []).map(b => b.badge),
                isFollowing: !!isFollowing,
                user: req.session.user, isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
              });
              if (req.session.user && req.session.user !== u) {
                db.get('SELECT * FROM follows WHERE follower=? AND following=?',
                  [req.session.user, u], (er5, row) => finish(row));
              } else finish(null);
            });
          });
        });
      });
    });
  });
});

app.post('/profile/update', requireLogin, (req, res) => {
  const { bio, email } = req.body;
  db.run('UPDATE users SET bio=?, email=? WHERE username=?',
    [bio, email || '', req.session.user], () => res.redirect('/profile/' + req.session.user));
});

app.post('/profile/avatar', requireLogin, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.redirect('/profile/' + req.session.user);
  const avatarUrl = '/uploads/' + req.file.filename;
  db.run('UPDATE users SET avatar=? WHERE username=?', [avatarUrl, req.session.user],
    () => res.redirect('/profile/' + req.session.user));
});

app.get('/settings', requireLogin, (req, res) => {
  db.get('SELECT * FROM users WHERE username=?', [req.session.user], (e, u) => {
    res.render('settings', {
      userData: u || {}, user: req.session.user, isAdmin: res.locals.isAdmin,
      notifCount: res.locals.notifCount, msg: req.query.msg || ''
    });
  });
});

app.post('/settings/password', requireLogin, async (req, res) => {
  const { oldPass, newPass } = req.body;
  db.get('SELECT * FROM users WHERE username=?', [req.session.user], async (e, u) => {
    const ok = await bcrypt.compare(oldPass, u.password);
    if (!ok) return res.redirect('/settings?msg=Eski+sifre+yanlis');
    const hash = await bcrypt.hash(newPass, 10);
    db.run('UPDATE users SET password=? WHERE username=?', [hash, req.session.user],
      () => res.redirect('/settings?msg=Sifre+guncellendi'));
  });
});

app.post('/follow/:username', requireLogin, (req, res) => {
  const target = req.params.username;
  if (target === req.session.user) return res.redirect('back');
  db.get('SELECT * FROM follows WHERE follower=? AND following=?', [req.session.user, target], (e, row) => {
    if (row) {
      db.run('DELETE FROM follows WHERE follower=? AND following=?', [req.session.user, target], () => res.redirect('back'));
    } else {
      db.run('INSERT INTO follows (follower, following) VALUES (?, ?)', [req.session.user, target], () => {
        notify(target, req.session.user + ' sizi takip etmeye basladi', '/profile/' + req.session.user);
        res.redirect('back');
      });
    }
  });
});

app.get('/notifications', requireLogin, (req, res) => {
  db.all('SELECT * FROM notifications WHERE username=? ORDER BY id DESC LIMIT 50',
    [req.session.user], (e, notifs) => {
      db.run('UPDATE notifications SET is_read=1 WHERE username=?', [req.session.user]);
      res.render('notifications', { notifs: notifs || [], user: req.session.user, isAdmin: res.locals.isAdmin, notifCount: 0 });
    });
});

app.get('/users', (req, res) => {
  const q = req.query.q || '';
  db.all('SELECT username, avatar, bio, role, points FROM users WHERE username LIKE ? AND banned=0 LIMIT 50',
    ['%'+q+'%'], (e, users) => {
      res.render('users', { users: users || [], q, user: req.session.user, isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount });
    });
});

app.get('/admin', requireLogin, requireAdmin, (req, res) => {
  db.all('SELECT * FROM users ORDER BY id', (e, users) => {
    db.get('SELECT COUNT(*) as c FROM posts', (e2, pc) => {
      db.get('SELECT COUNT(*) as c FROM comments', (e3, cc) => {
        db.get('SELECT COUNT(*) as c FROM likes', (e4, lc) => {
          res.render('admin', {
            users: users || [], postCount: pc.c, commentCount: cc.c, likeCount: lc.c,
            user: req.session.user, isAdmin: true, notifCount: res.locals.notifCount
          });
        });
      });
    });
  });
});

app.post('/admin/ban/:username', requireLogin, requireAdmin, (req, res) => {
  const u = req.params.username;
  if (u === req.session.user) return res.redirect('/admin');
  db.get('SELECT banned FROM users WHERE username=?', [u], (e, x) => {
    if (!x) return res.redirect('/admin');
    db.run('UPDATE users SET banned=? WHERE username=?', [x.banned ? 0 : 1, u], () => res.redirect('/admin'));
  });
});

app.post('/admin/role/:username', requireLogin, requireAdmin, (req, res) => {
  const u = req.params.username;
  if (u === req.session.user) return res.redirect('/admin');
  db.get('SELECT role FROM users WHERE username=?', [u], (e, x) => {
    if (!x) return res.redirect('/admin');
    const roles = ['user', 'mod', 'admin'];
    const curIdx = roles.indexOf(x.role);
    const nextRole = roles[(curIdx + 1) % roles.length];
    db.run('UPDATE users SET role=? WHERE username=?', [nextRole, u], () => res.redirect('/admin'));
  });
});

app.post('/admin/delete-user/:username', requireLogin, requireAdmin, (req, res) => {
  const u = req.params.username;
  if (u === req.session.user) return res.redirect('/admin');
  db.run('DELETE FROM users WHERE username=?', [u], () => {
    db.run('DELETE FROM posts WHERE author=?', [u], () => res.redirect('/admin'));
  });
});

app.get('/stats', (req, res) => {
  db.get('SELECT COUNT(*) as c FROM users', (e1, uc) => {
    db.get('SELECT COUNT(*) as c FROM posts', (e2, pc) => {
      db.get('SELECT COUNT(*) as c FROM comments', (e3, cc) => {
        db.get('SELECT COUNT(*) as c FROM likes', (e4, lc) => {
          db.all('SELECT author, COUNT(*) as c FROM posts GROUP BY author ORDER BY c DESC LIMIT 5', (e5, topPosters) => {
            db.all('SELECT * FROM posts ORDER BY likes DESC LIMIT 5', (e6, topPosts) => {
              res.render('stats', {
                userCount: uc.c, postCount: pc.c, commentCount: cc.c, likeCount: lc.c,
                topPosters: topPosters || [], topPosts: topPosts || [],
                user: req.session.user, isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
              });
            });
          });
        });
      });
    });
  });
});


// ==================== ASAMA 2: ARKADAS SISTEMI ====================
app.post('/friend-request/:username', requireLogin, (req, res) => {
  const target = req.params.username;
  if (target === req.session.user) return res.redirect('back');
  db.get('SELECT * FROM blocks WHERE blocker=? AND blocked=?', [target, req.session.user], (e, b) => {
    if (b) return res.redirect('back');
    db.get('SELECT * FROM friend_requests WHERE sender=? AND receiver=?', [req.session.user, target], (e2, existing) => {
      if (existing) {
        db.run('DELETE FROM friend_requests WHERE id=?', [existing.id], () => res.redirect('back'));
      } else {
        db.get('SELECT * FROM friend_requests WHERE sender=? AND receiver=? AND status="accepted"', [target, req.session.user], (e3, accepted) => {
          if (accepted) return res.redirect('back');
          db.run('INSERT INTO friend_requests (sender, receiver, date) VALUES (?, ?, ?)',
            [req.session.user, target, new Date().toLocaleString('tr-TR')], () => {
              notify(target, req.session.user + ' size arkadaslik istegi gonderdi', '/friends');
              res.redirect('back');
            });
        });
      }
    });
  });
});

app.post('/friend-accept/:id', requireLogin, (req, res) => {
  db.get('SELECT * FROM friend_requests WHERE id=?', [req.params.id], (e, fr) => {
    if (!fr || fr.receiver !== req.session.user) return res.redirect('/friends');
    db.run('UPDATE friend_requests SET status="accepted" WHERE id=?', [req.params.id], () => {
      db.run('UPDATE friend_requests SET status="accepted" WHERE sender=? AND receiver=? AND status="accepted"',
        [req.session.user, fr.sender]);
      notify(fr.sender, req.session.user + ' arkadaslik isteginizi kabul etti', '/friends');
      res.redirect('/friends');
    });
  });
});

app.post('/friend-reject/:id', requireLogin, (req, res) => {
  db.get('SELECT * FROM friend_requests WHERE id=?', [req.params.id], (e, fr) => {
    if (!fr || fr.receiver !== req.session.user) return res.redirect('/friends');
    db.run('DELETE FROM friend_requests WHERE id=?', [req.params.id], () => res.redirect('/friends'));
  });
});

app.get('/friends', requireLogin, (req, res) => {
  db.all('SELECT * FROM friend_requests WHERE (sender=? OR receiver=?) AND status="accepted"',
    [req.session.user, req.session.user], (e, friends) => {
      db.all('SELECT fr.*, u.avatar FROM friend_requests fr LEFT JOIN users u ON u.username = fr.sender WHERE fr.receiver=? AND fr.status="pending"',
        [req.session.user], (e2, requests) => {
          db.all('SELECT fr.*, u.avatar FROM friend_requests fr LEFT JOIN users u ON u.username = fr.sender WHERE fr.sender=? AND fr.status="pending"',
            [req.session.user], (e3, sent) => {
              const friendList = (friends || []).map(f => ({
                username: f.sender === req.session.user ? f.receiver : f.sender
              }));
              res.render('friends', {
                friends: friendList, requests: requests || [], sent: sent || [],
                user: req.session.user, isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
              });
            });
        });
    });
});

// ==================== ASAMA 2: ENGELLEME ====================
app.post('/block/:username', requireLogin, (req, res) => {
  const target = req.params.username;
  if (target === req.session.user) return res.redirect('back');
  db.get('SELECT * FROM blocks WHERE blocker=? AND blocked=?', [req.session.user, target], (e, existing) => {
    if (existing) {
      db.run('DELETE FROM blocks WHERE blocker=? AND blocked=?', [req.session.user, target], () => res.redirect('back'));
    } else {
      db.run('INSERT INTO blocks (blocker, blocked, date) VALUES (?, ?, ?)',
        [req.session.user, target, new Date().toLocaleString('tr-TR')], () => res.redirect('back'));
    }
  });
});

app.get('/blocklist', requireLogin, (req, res) => {
  db.all('SELECT * FROM blocks WHERE blocker=?', [req.session.user], (e, blocks) => {
    res.render('blocklist', {
      blocks: blocks || [], user: req.session.user,
      isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
    });
  });
});

// ==================== ASAMA 2: OZEL MESAJ (DM) ====================
app.get('/messages', requireLogin, (req, res) => {
  db.all(`SELECT 
    CASE WHEN sender=? THEN receiver ELSE sender END as other_user,
    MAX(id) as last_id,
    MAX(date) as last_date
    FROM messages
    WHERE sender=? OR receiver=?
    GROUP BY other_user
    ORDER BY last_id DESC`,
    [req.session.user, req.session.user, req.session.user], (e, convos) => {
      const convList = (convos || []).map(c => ({
        username: c.other_user,
        last_date: c.last_date
      }));
      res.render('messages', {
        conversations: convList, user: req.session.user,
        isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
      });
    });
});

app.get('/messages/:username', requireLogin, (req, res) => {
  const other = req.params.username;
  db.get('SELECT * FROM users WHERE username=?', [other], (e, otherUser) => {
    if (!otherUser) return res.redirect('/messages');
    db.get('SELECT * FROM blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)',
      [req.session.user, other, other, req.session.user], (e2, block) => {
        const isBlocked = !!block;
        db.all(`SELECT * FROM messages 
          WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?)
          ORDER BY id ASC`,
          [req.session.user, other, other, req.session.user], (e3, msgs) => {
            db.run('UPDATE messages SET is_read=1 WHERE receiver=? AND sender=?',
              [req.session.user, other]);
            res.render('chat', {
              otherUser, messages: msgs || [], isBlocked,
              user: req.session.user, isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
            });
          });
      });
  });
});

app.post('/messages/:username', requireLogin, (req, res) => {
  const other = req.params.username;
  const { content } = req.body;
  if (!content || !content.trim()) return res.redirect('/messages/' + other);
  db.get('SELECT * FROM blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)',
    [req.session.user, other, other, req.session.user], (e, block) => {
      if (block) return res.redirect('/messages/' + other);
      db.run('INSERT INTO messages (sender, receiver, content, date) VALUES (?, ?, ?, ?)',
        [req.session.user, other, content.trim(), new Date().toLocaleString('tr-TR')], () => {
          notify(other, req.session.user + ' size mesaj gonderdi', '/messages/' + req.session.user);
          res.redirect('/messages/' + other);
        });
    });
});

app.get('/api/messages/:username', requireLogin, (req, res) => {
  const other = req.params.username;
  db.all(`SELECT * FROM messages 
    WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?)
    ORDER BY id ASC`,
    [req.session.user, other, other, req.session.user], (e, msgs) => {
      res.json(msgs || []);
    });
});

// ==================== ASAMA 2: KULLANICI ISTATISTIKLERI ====================
app.get('/activity', (req, res) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleString('tr-TR');
  db.all('SELECT username, avatar, points, last_login FROM users WHERE banned=0 AND last_login > ? ORDER BY last_login DESC',
    [dayAgo], (e, activeUsers) => {
      db.all(`SELECT username, avatar, points, 
        (SELECT COUNT(*) FROM posts WHERE author=users.username) as post_count,
        (SELECT COUNT(*) FROM comments WHERE author=users.username) as comment_count
        FROM users WHERE banned=0 ORDER BY points DESC LIMIT 20`, (e2, topUsers) => {
        res.render('activity', {
          activeUsers: activeUsers || [], topUsers: topUsers || [],
          user: req.session.user, isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
        });
      });
    });
});

// ==================== ASAMA 3: KONU BOOST ====================
app.post('/post/:id/boost', requireLogin, (req, res) => {
  db.get('SELECT * FROM posts WHERE id=?', [req.params.id], (e, post) => {
    if (!post) return res.redirect('/');
    if (post.author !== req.session.user) return res.redirect('/post/' + post.id);
    if (post.boosted) return res.redirect('/post/' + post.id);
    db.get('SELECT points FROM users WHERE username=?', [req.session.user], (e2, u) => {
      if (!u || u.points < 50) return res.redirect('/post/' + post.id + '?msg=Yetersiz+puan+(50+gerekli)');
      db.run('UPDATE users SET points = points - 50 WHERE username=?', [req.session.user]);
      db.run('UPDATE posts SET boosted=1, boosted_until=? WHERE id=?',
        [new Date(Date.now() + 24*60*60*1000).toLocaleString('tr-TR'), post.id],
        () => res.redirect('/post/' + post.id));
    });
  });
});

// ==================== ASAMA 3: ARSIV ====================
app.post('/post/:id/archive', requireLogin, requireAdmin, (req, res) => {
  db.get('SELECT archived FROM posts WHERE id=?', [req.params.id], (e, p) => {
    if (!p) return res.redirect('/');
    db.run('UPDATE posts SET archived=? WHERE id=?', [p.archived ? 0 : 1, req.params.id],
      () => res.redirect('back'));
  });
});

app.get('/archive', (req, res) => {
  db.all('SELECT * FROM posts WHERE archived=1 ORDER BY id DESC LIMIT 50', (e, posts) => {
    res.render('archive', {
      posts: posts || [], user: req.session.user,
      isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
    });
  });
});

// ==================== ASAMA 3: OKUNDU ISARETI ====================
app.post('/post/:id/read', requireLogin, (req, res) => {
  db.run('INSERT OR IGNORE INTO read_posts (post_id, username, read_at) VALUES (?, ?, ?)',
    [req.params.id, req.session.user, new Date().toLocaleString('tr-TR')],
    () => res.json({ ok: true }));
});

app.post('/post/:id/mark-unread', requireLogin, (req, res) => {
  db.run('DELETE FROM read_posts WHERE post_id=? AND username=?',
    [req.params.id, req.session.user], () => res.redirect('back'));
});

// ==================== ASAMA 3: KONU TAKIP ====================
app.post('/post/:id/follow', requireLogin, (req, res) => {
  db.get('SELECT * FROM post_follows WHERE post_id=? AND username=?',
    [req.params.id, req.session.user], (e, row) => {
      if (row) {
        db.run('DELETE FROM post_follows WHERE post_id=? AND username=?',
          [req.params.id, req.session.user], () => res.redirect('back'));
      } else {
        db.run('INSERT INTO post_follows (post_id, username, date) VALUES (?, ?, ?)',
          [req.params.id, req.session.user, new Date().toLocaleString('tr-TR')],
          () => res.redirect('back'));
      }
    });
});

app.get('/following-posts', requireLogin, (req, res) => {
  db.all(`SELECT p.* FROM posts p 
    INNER JOIN post_follows f ON p.id = f.post_id 
    WHERE f.username=? ORDER BY p.id DESC LIMIT 50`,
    [req.session.user], (e, posts) => {
      res.render('following-posts', {
        posts: posts || [], user: req.session.user,
        isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
      });
    });
});

// ==================== ASAMA 3: GORUNTULEME GECMISI ====================
app.get('/history', requireLogin, (req, res) => {
  db.all(`SELECT DISTINCT p.*, v.viewed_at FROM posts p 
    INNER JOIN view_history v ON p.id = v.post_id 
    WHERE v.username=? 
    GROUP BY p.id 
    ORDER BY v.id DESC LIMIT 30`,
    [req.session.user], (e, posts) => {
      res.render('history', {
        posts: posts || [], user: req.session.user,
        isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
      });
    });
});

app.get('/api/similar/:id', (req, res) => {
  const postId = req.params.id;
  db.get('SELECT category, tags FROM posts WHERE id=?', [postId], (e, post) => {
    if (!post) return res.json([]);
    const tagList = (post.tags || '').split(',').filter(t => t);
    let sql = 'SELECT id, title, likes, views FROM posts WHERE id != ? AND (category = ?';
    const params = [postId, post.category];
    if (tagList.length > 0) {
      sql += ' OR tags LIKE ?';
      params.push('%' + tagList[0] + '%');
    }
    sql += ') ORDER BY likes DESC LIMIT 5';
    db.all(sql, params, (e2, similar) => {
      res.json(similar || []);
    });
  });
});

// ==================== ASAMA 4: SIKAYET SISTEMI ====================
app.post('/report/:type/:id', requireLogin, (req, res) => {
  const { type, id } = req.params;
  const { reason } = req.body;
  if (!['post', 'comment', 'user'].includes(type)) return res.redirect('back');
  if (!reason || !reason.trim()) return res.redirect('back');
  db.run('INSERT INTO reports (reporter, target_type, target_id, reason, date) VALUES (?, ?, ?, ?, ?)',
    [req.session.user, type, parseInt(id), reason.trim(), new Date().toLocaleString('tr-TR')],
    () => {
      // Adminlere bildirim
      db.all('SELECT username FROM users WHERE role IN ("admin","mod")', (e, admins) => {
        (admins || []).forEach(a => {
          notify(a.username, req.session.user + ' bir ' + type + ' şikayet etti', '/mod/reports');
        });
      });
      res.redirect('back');
    });
});

// ==================== ASAMA 4: MOD PANELI ====================
app.get('/mod', requireLogin, requireAdmin, (req, res) => {
  db.get('SELECT COUNT(*) as c FROM reports WHERE status="pending"', (e1, pending) => {
    db.get('SELECT COUNT(*) as c FROM warnings', (e2, warnCount) => {
      db.get('SELECT COUNT(*) as c FROM banned_words', (e3, wordCount) => {
        db.get('SELECT COUNT(*) as c FROM banned_ips', (e4, ipCount) => {
          res.render('mod-panel', {
            user: req.session.user, isAdmin: true, notifCount: res.locals.notifCount,
            pendingReports: pending.c, warningCount: warnCount.c,
            bannedWordCount: wordCount.c, bannedIpCount: ipCount.c
          });
        });
      });
    });
  });
});

// ==================== ASAMA 4: RAPORLAR ====================
app.get('/mod/reports', requireLogin, requireAdmin, (req, res) => {
  db.all('SELECT * FROM reports ORDER BY status ASC, id DESC LIMIT 100', (e, reports) => {
    res.render('mod-reports', {
      reports: reports || [], user: req.session.user,
      isAdmin: true, notifCount: res.locals.notifCount
    });
  });
});

app.post('/mod/reports/:id/resolve', requireLogin, requireAdmin, (req, res) => {
  db.run('UPDATE reports SET status="resolved" WHERE id=?', [req.params.id],
    () => res.redirect('/mod/reports'));
});

app.post('/mod/reports/:id/reject', requireLogin, requireAdmin, (req, res) => {
  db.run('UPDATE reports SET status="rejected" WHERE id=?', [req.params.id],
    () => res.redirect('/mod/reports'));
});

// ==================== ASAMA 4: UYARI SISTEMI ====================
app.post('/mod/warn/:username', requireLogin, requireAdmin, (req, res) => {
  const { reason } = req.body;
  const target = req.params.username;
  if (!reason) return res.redirect('back');
  db.run('INSERT INTO warnings (username, moderator, reason, date) VALUES (?, ?, ?, ?)',
    [target, req.session.user, reason, new Date().toLocaleString('tr-TR')], () => {
      db.run('UPDATE users SET warning_count = warning_count + 1 WHERE username=?', [target]);
      notify(target, '⚠️ ' + req.session.user + ' size uyarı verdi: ' + reason, '/profile/' + target);
      res.redirect('back');
    });
});

app.get('/mod/warnings/:username', requireLogin, requireAdmin, (req, res) => {
  const target = req.params.username;
  db.all('SELECT * FROM warnings WHERE username=? ORDER BY id DESC', [target], (e, warns) => {
    db.all('SELECT * FROM admin_notes WHERE username=? ORDER BY id DESC', [target], (e2, notes) => {
      db.get('SELECT * FROM users WHERE username=?', [target], (e3, userData) => {
        if (!userData) return res.redirect('/mod');
        res.render('mod-warnings', {
          target: target, userData, warnings: warns || [], notes: notes || [],
          user: req.session.user, isAdmin: true, notifCount: res.locals.notifCount
        });
      });
    });
  });
});

// ==================== ASAMA 4: YASAKLI KELIMELER ====================
app.get('/mod/banned-words', requireLogin, requireAdmin, (req, res) => {
  db.all('SELECT * FROM banned_words ORDER BY id DESC', (e, words) => {
    res.render('mod-banned-words', {
      words: words || [], user: req.session.user,
      isAdmin: true, notifCount: res.locals.notifCount
    });
  });
});

app.post('/mod/banned-words', requireLogin, requireAdmin, (req, res) => {
  const { word } = req.body;
  if (!word || !word.trim()) return res.redirect('/mod/banned-words');
  db.run('INSERT OR IGNORE INTO banned_words (word, date) VALUES (?, ?)',
    [word.trim().toLowerCase(), new Date().toLocaleString('tr-TR')],
    () => res.redirect('/mod/banned-words'));
});

app.post('/mod/banned-words/:id/delete', requireLogin, requireAdmin, (req, res) => {
  db.run('DELETE FROM banned_words WHERE id=?', [req.params.id],
    () => res.redirect('/mod/banned-words'));
});

// ==================== ASAMA 4: YASAKLI IP'LER ====================
app.get('/mod/banned-ips', requireLogin, requireAdmin, (req, res) => {
  db.all('SELECT * FROM banned_ips ORDER BY id DESC', (e, ips) => {
    res.render('mod-banned-ips', {
      ips: ips || [], user: req.session.user,
      isAdmin: true, notifCount: res.locals.notifCount
    });
  });
});

app.post('/mod/banned-ips', requireLogin, requireAdmin, (req, res) => {
  const { ip, reason } = req.body;
  if (!ip || !ip.trim()) return res.redirect('/mod/banned-ips');
  db.run('INSERT OR IGNORE INTO banned_ips (ip, reason, date) VALUES (?, ?, ?)',
    [ip.trim(), reason || '', new Date().toLocaleString('tr-TR')],
    () => res.redirect('/mod/banned-ips'));
});

app.post('/mod/banned-ips/:id/delete', requireLogin, requireAdmin, (req, res) => {
  db.run('DELETE FROM banned_ips WHERE id=?', [req.params.id],
    () => res.redirect('/mod/banned-ips'));
});

// ==================== ASAMA 4: ADMIN NOTLARI ====================
app.post('/mod/notes/:username', requireLogin, requireAdmin, (req, res) => {
  const { note } = req.body;
  const target = req.params.username;
  if (!note || !note.trim()) return res.redirect('back');
  db.run('INSERT INTO admin_notes (username, note, moderator, date) VALUES (?, ?, ?, ?)',
    [target, note.trim(), req.session.user, new Date().toLocaleString('tr-TR')],
    () => res.redirect('/mod/warnings/' + target));
});

// ==================== ASAMA 4: SPAM FILTRESI ====================
function checkSpam(text) {
  return new Promise((resolve) => {
    db.all('SELECT word FROM banned_words', (e, words) => {
      const lower = (text || '').toLowerCase();
      let score = 0;
      let matched = [];
      (words || []).forEach(w => {
        if (lower.includes(w.word)) { score += 10; matched.push(w.word); }
      });
      // Link spamı
      const linkCount = (lower.match(/https?:\/\//g) || []).length;
      if (linkCount > 3) { score += linkCount * 2; matched.push('çok link'); }
      resolve({ score, matched });
    });
  });
}

// ==================== ASAMA 5: SON AKTIVITE ====================
app.use((req, res, next) => {
  if (req.session.user) {
    db.run('UPDATE users SET last_seen=? WHERE username=?',
      [new Date().toISOString(), req.session.user]);
  }
  next();
});

// ==================== ASAMA 5: ONLINE KULLANICILAR ====================
app.get('/api/online', (req, res) => {
  const fiveMinAgo = new Date(Date.now() - 5*60*1000).toISOString();
  db.all('SELECT username, avatar, last_seen FROM users WHERE banned=0 AND last_seen > ? ORDER BY last_seen DESC LIMIT 30',
    [fiveMinAgo], (e, users) => {
      res.json(users || []);
    });
});

app.get('/online', (req, res) => {
  const fiveMinAgo = new Date(Date.now() - 5*60*1000).toISOString();
  db.all('SELECT username, avatar, last_seen, points FROM users WHERE banned=0 AND last_seen > ? ORDER BY last_seen DESC LIMIT 50',
    [fiveMinAgo], (e, online) => {
      res.render('online', {
        online: online || [], user: req.session.user,
        isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount
      });
    });
});

// ==================== ASAMA 5: SON AKTIVITE BILGISI ====================
app.get('/api/activity/:username', (req, res) => {
  db.get('SELECT last_seen FROM users WHERE username=?', [req.params.username], (e, u) => {
    if (!u || !u.last_seen) return res.json({ status: 'offline' });
    const diff = Date.now() - new Date(u.last_seen).getTime();
    let status = 'offline';
    if (diff < 5*60*1000) status = 'online';
    else if (diff < 60*60*1000) status = 'recent';
    else if (diff < 24*60*60*1000) status = 'today';
    res.json({ status, last_seen: u.last_seen });
  });
});

// ==================== ASAMA 5: KONU ONIZLEME ====================
app.get('/api/preview/post/:id', (req, res) => {
  db.get('SELECT id, title, content, author, likes, views, category FROM posts WHERE id=?',
    [req.params.id], (e, p) => {
      if (!p) return res.json(null);
      p.preview = (p.content || '').substring(0, 200).replace(/\n/g, ' ');
      delete p.content;
      res.json(p);
    });
});

app.get('/api/preview/user/:username', (req, res) => {
  db.get('SELECT username, avatar, bio, points, role FROM users WHERE username=?',
    [req.params.username], (e, u) => {
      if (!u) return res.json(null);
      db.get('SELECT COUNT(*) as c FROM posts WHERE author=?', [u.username], (e2, pc) => {
        db.get('SELECT COUNT(*) as c FROM comments WHERE author=?', [u.username], (e3, cc) => {
          u.postCount = pc ? pc.c : 0;
          u.commentCount = cc ? cc.c : 0;
          res.json(u);
        });
      });
    });
});

// ==================== ASAMA 5: SON GORULME GUNCELLE ====================
app.post('/api/heartbeat', requireLogin, (req, res) => {
  db.run('UPDATE users SET last_seen=? WHERE username=?',
    [new Date().toISOString(), req.session.user], () => res.json({ ok: true }));
});
app.use((req, res) => {
  res.status(404).render('404', { user: req.session.user, isAdmin: res.locals.isAdmin, notifCount: res.locals.notifCount });
});

db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, content TEXT, is_read INTEGER DEFAULT 0, date TEXT)`);
db.run(`CREATE TABLE IF NOT EXISTS friend_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, status TEXT DEFAULT "pending", date TEXT, UNIQUE(sender, receiver))`);
db.run(`CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, blocker TEXT, blocked TEXT, date TEXT, UNIQUE(blocker, blocked))`);
app.listen(3000, () => console.log('Forum calisiyor: http://localhost:3000'));
