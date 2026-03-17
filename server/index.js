require('dotenv').config();
const express = require('express');
const session = require('express-session');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Data
const schools = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/colorado-schools.json')));
const workforceCenters = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/workforce-centers.json')));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'pathway-trades-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── GRANT ELIGIBILITY ENGINE ──────────────────────────────────────
function checkEligibility(answers) {
  const grants = [];

  // WIOA Adult (18+, unemployed or underemployed)
  if (answers.age >= 18 && (answers.employed === 'no' || answers.employed === 'parttime')) {
    const annualIncome = parseInt(answers.income) || 0;
    grants.push({
      name: 'WIOA Individual Training Account (ITA)',
      amount: '$3,000 – $15,000',
      covers: 'Tuition, books, tools, certifications',
      timeline: '2–4 weeks to get approved',
      how: 'Your local Colorado Workforce Center assigns you a case worker and issues a training voucher',
      priority: 1,
      tag: 'wioa'
    });
  }

  // WIOA Dislocated Worker
  if (answers.job_loss === 'yes') {
    grants.push({
      name: 'WIOA Dislocated Worker Program',
      amount: '$5,000 – $15,000',
      covers: 'Tuition + potential living stipend',
      timeline: '2–3 weeks',
      how: 'For workers laid off, downsized, or whose company closed. Higher funding than standard WIOA.',
      priority: 1,
      tag: 'wioa_dw'
    });
  }

  // Pell Grant
  const annualIncome = parseInt(answers.income) || 999999;
  if (annualIncome < 60000) {
    let pellAmount = '$7,395';
    if (annualIncome < 20000) pellAmount = '$7,395 (max)';
    else if (annualIncome < 40000) pellAmount = '$4,000 – $7,000';
    else pellAmount = '$1,000 – $4,000';
    grants.push({
      name: 'Federal Pell Grant',
      amount: pellAmount,
      covers: 'Tuition at any approved school',
      timeline: '1–2 weeks after FAFSA submission',
      how: 'Submit your FAFSA at studentaid.gov — takes about 20 minutes. No repayment required.',
      priority: 2,
      tag: 'pell'
    });
  }

  // Trade Adjustment Assistance
  if (answers.job_loss_reason === 'trade' || answers.job_loss_reason === 'outsourced') {
    grants.push({
      name: 'Trade Adjustment Assistance (TAA)',
      amount: 'Full tuition + living stipend up to $1,500/mo',
      covers: 'Full cost of training + income support while in school',
      timeline: '3–6 weeks (most generous program available)',
      how: 'For workers displaced due to foreign trade/imports or outsourcing. Apply through your Workforce Center.',
      priority: 1,
      tag: 'taa'
    });
  }

  // Colorado Workforce Development Grant (state-level)
  grants.push({
    name: 'Colorado Workforce Development Grant',
    amount: '$1,000 – $5,000',
    covers: 'Supplemental training costs',
    timeline: '1–3 weeks',
    how: 'State-funded supplement to federal grants. Available through Colorado Workforce Centers.',
    priority: 3,
    tag: 'co_state'
  });

  // Veterans
  if (answers.veteran === 'yes') {
    grants.push({
      name: 'Veterans\' Employment Through Technology Education Courses (VET TEC)',
      amount: 'Full tuition',
      covers: 'Full tuition at approved programs',
      timeline: '2–4 weeks',
      how: 'VA-funded program for veterans entering tech or trade careers. Apply at va.gov.',
      priority: 1,
      tag: 'veteran'
    });
  }

  return grants.sort((a, b) => a.priority - b.priority);
}

// Find nearest workforce center by zip
function findNearestCenter(zip) {
  // Simple Colorado region matching by zip prefix
  const zipNum = parseInt(zip);
  if (zipNum >= 80200 && zipNum <= 80299) return workforceCenters[0]; // Denver
  if (zipNum >= 80010 && zipNum <= 80019) return workforceCenters[1]; // Aurora
  if (zipNum >= 80900 && zipNum <= 80999) return workforceCenters[2]; // Colorado Springs
  if (zipNum >= 80630 && zipNum <= 80639) return workforceCenters[3]; // Greeley
  if (zipNum >= 81000 && zipNum <= 81099) return workforceCenters[4]; // Pueblo
  if (zipNum >= 80520 && zipNum <= 80529) return workforceCenters[5]; // Fort Collins
  if (zipNum >= 81500 && zipNum <= 81509) return workforceCenters[6]; // Grand Junction
  return workforceCenters[0]; // Default Denver
}

// Filter schools by trade interest and location
function matchSchools(tradeInterest, zip) {
  const zipNum = parseInt(zip);
  // Rough region grouping
  let regionSchools = schools;
  if (zipNum >= 80900 && zipNum <= 80999) {
    regionSchools = schools.filter(s => ['intellitec-colorado-springs', 'pueblo-community', 'trinidad-state'].includes(s.id));
  } else if (zipNum >= 81000 && zipNum <= 81099) {
    regionSchools = schools.filter(s => ['pueblo-community', 'trinidad-state'].includes(s.id));
  } else if (zipNum >= 80630 && zipNum <= 80639) {
    regionSchools = schools.filter(s => ['aims-community', 'front-range'].includes(s.id));
  } else if (zipNum >= 80520 && zipNum <= 80529) {
    regionSchools = schools.filter(s => ['front-range', 'aims-community'].includes(s.id));
  } else {
    regionSchools = schools.filter(s => ['emily-griffith', 'pickens-tech', 'front-range', 'concorde-aurora'].includes(s.id));
  }

  if (tradeInterest && tradeInterest !== 'unsure') {
    const matched = regionSchools.filter(s =>
      s.programs.some(p => p.toLowerCase().includes(tradeInterest.toLowerCase()))
    );
    return matched.length > 0 ? matched : regionSchools;
  }
  return regionSchools;
}

// ─── EMAIL REFERRAL ────────────────────────────────────────────────
async function sendReferral(applicant, grants, school, center) {
  if (!process.env.EMAIL_USER) return; // Skip if not configured
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });

  // Email to applicant
  await transporter.sendMail({
    from: `"Colorado Pathway to Trades" <${process.env.EMAIL_USER}>`,
    to: applicant.email,
    subject: '✅ Your Grant Application Has Been Started',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0f0f1a;color:#fff;padding:32px;border-radius:12px">
        <h1 style="color:#4CAF50">You're on your way! 🎓</h1>
        <p>Hi ${applicant.name},</p>
        <p>We've matched you with <strong>${grants.length} grant program(s)</strong> you qualify for and referred your information to your local Workforce Center.</p>
        <h2 style="color:#5865F2">Your Grants</h2>
        ${grants.map(g => `<div style="background:#1a1a2e;padding:16px;border-radius:8px;margin-bottom:12px">
          <strong>${g.name}</strong><br>
          💰 Amount: ${g.amount}<br>
          📋 Covers: ${g.covers}<br>
          ⏱ Timeline: ${g.timeline}
        </div>`).join('')}
        <h2 style="color:#5865F2">Your Workforce Center Contact</h2>
        <div style="background:#1a1a2e;padding:16px;border-radius:8px">
          <strong>${center.name}</strong><br>
          📍 ${center.address}<br>
          📞 ${center.phone}<br>
          🌐 <a href="${center.url}" style="color:#5865F2">${center.url}</a>
        </div>
        ${school ? `<h2 style="color:#5865F2">Recommended School</h2>
        <div style="background:#1a1a2e;padding:16px;border-radius:8px">
          <strong>${school.name}</strong> — ${school.city}<br>
          📞 ${school.phone}<br>
          🌐 <a href="${school.website}" style="color:#5865F2">${school.website}</a><br>
          ✅ Programs: ${school.programs.join(', ')}<br>
          <a href="${school.enroll_url}" style="display:inline-block;margin-top:12px;background:#4CAF50;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">Start Enrollment →</a>
        </div>` : ''}
        <p style="color:#888;font-size:12px;margin-top:24px">Colorado Pathway to Trades — helping Colorado workers find their path.</p>
      </div>
    `
  });

  // Email to workforce center
  await transporter.sendMail({
    from: `"Colorado Pathway to Trades" <${process.env.EMAIL_USER}>`,
    to: center.email,
    subject: `New Grant Referral — ${applicant.name}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px">
        <h2>New Referral from Colorado Pathway to Trades</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr><td><strong>Name:</strong></td><td>${applicant.name}</td></tr>
          <tr><td><strong>Email:</strong></td><td>${applicant.email}</td></tr>
          <tr><td><strong>Phone:</strong></td><td>${applicant.phone}</td></tr>
          <tr><td><strong>Zip:</strong></td><td>${applicant.zip}</td></tr>
          <tr><td><strong>Trade Interest:</strong></td><td>${applicant.trade}</td></tr>
          <tr><td><strong>Grants Qualified:</strong></td><td>${grants.map(g => g.name).join(', ')}</td></tr>
          <tr><td><strong>Selected School:</strong></td><td>${school ? school.name : 'Not selected yet'}</td></tr>
        </table>
        <p>Please reach out to this applicant within 48 hours to begin their Individual Training Account process.</p>
      </div>
    `
  });
}

// ─── ROUTES ────────────────────────────────────────────────────────

// Landing page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// Quiz step 1
app.get('/apply', (req, res) => res.sendFile(path.join(__dirname, '../public/apply.html')));

// API: check eligibility
app.post('/api/eligibility', (req, res) => {
  const answers = req.body;
  req.session.answers = answers;
  const grants = checkEligibility(answers);
  const center = findNearestCenter(answers.zip || '80202');
  const matchedSchools = matchSchools(answers.trade, answers.zip || '80202');
  req.session.grants = grants;
  req.session.center = center;
  req.session.schools = matchedSchools;
  res.json({ grants, center, schools: matchedSchools });
});

// API: submit application
app.post('/api/apply', async (req, res) => {
  const { name, email, phone, school_id } = req.body;
  const grants = req.session.grants || [];
  const center = req.session.center || workforceCenters[0];
  const school = schools.find(s => s.id === school_id) || null;

  try {
    await sendReferral({ name, email, phone, zip: req.session.answers?.zip, trade: req.session.answers?.trade }, grants, school, center);
  } catch(e) {
    console.error('Email failed:', e.message);
  }

  // Save to simple JSON log
  const logPath = path.join(__dirname, '../data/applications.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(logPath)); } catch(e) {}
  log.push({
    id: Date.now(),
    name, email, phone,
    school_id,
    grants: grants.map(g => g.tag),
    center: center.name,
    answers: req.session.answers,
    submitted_at: new Date().toISOString()
  });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

  res.json({ success: true, center, school, grants });
});

// ─── ADMIN ─────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));

app.get('/admin/api/applications', (req, res) => {
  const logPath = path.join(__dirname, '../data/applications.json');
  try {
    const apps = JSON.parse(fs.readFileSync(logPath));
    res.json(apps.reverse()); // newest first
  } catch(e) {
    res.json([]);
  }
});

app.get('/admin/api/stats', (req, res) => {
  const logPath = path.join(__dirname, '../data/applications.json');
  try {
    const apps = JSON.parse(fs.readFileSync(logPath));
    const today = apps.filter(a => new Date(a.submitted_at).toDateString() === new Date().toDateString()).length;
    const grants = {};
    apps.forEach(a => (a.grants||[]).forEach(g => { grants[g] = (grants[g]||0)+1; }));
    res.json({ total: apps.length, today, grants, estFunding: apps.length * 11000 });
  } catch(e) {
    res.json({ total: 0, today: 0, grants: {}, estFunding: 0 });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`🎓 Colorado Pathway to Trades running on port ${PORT}`));
