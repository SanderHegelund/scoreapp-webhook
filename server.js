const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;
const DATA_FILE = path.join(__dirname, 'data.json');

let store = {
  leads:      [],
  lastUpdated: null
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      store = JSON.parse(raw);
      console.log('Indlæste ' + store.leads.length + ' leads fra disk');
    }
  } catch (e) {
    console.warn('Kunne ikke indlæse data.json:', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.warn('Kunne ikke gemme data.json:', e.message);
  }
}

function calcStats(leads, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const filtered = days === 0
    ? leads
    : leads.filter(l => new Date(l.receivedAt) >= cutoff);

  const completed = filtered.length;
  const withContact = filtered.filter(l => l.email || l.phone).length;
  const meetings = filtered.filter(l => l.meetingBooked === true).length;

  // UTM-kilde fordeling
  const utmSources = {};
  filtered.forEach(l => {
    const src = l.utmSource || l.source || 'Direkte';
    utmSources[src] = (utmSources[src] || 0) + 1;
  });

  // UTM-kampagne fordeling
  const utmCampaigns = {};
  filtered.forEach(l => {
    const camp = l.utmCampaign || 'Ingen kampagne';
    utmCampaigns[camp] = (utmCampaigns[camp] || 0) + 1;
  });

  // Score fordeling (beholdes som fallback)
  const scoreDist = { 'Under 40': 0, '40–59': 0, '60–79': 0, '80–100': 0 };
  filtered.forEach(l => {
    const s = parseInt(l.score) || 0;
    if (s < 40)       scoreDist['Under 40']++;
    else if (s < 60)  scoreDist['40–59']++;
    else if (s < 80)  scoreDist['60–79']++;
    else              scoreDist['80–100']++;
  });

  // Daglig tidsserie
  const seriesMap = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    seriesMap[key] = 0;
  }
  filtered.forEach(l => {
    const key = l.receivedAt ? l.receivedAt.split('T')[0] : null;
    if (key && seriesMap.hasOwnProperty(key)) seriesMap[key]++;
  });

  return {
    completed,
    leads: withContact,
    meetings,
    completionRate: completed > 0 ? ((completed / Math.max(completed * 1.8, 1)) * 100).toFixed(1) : '0.0',
    leadRate: completed > 0 ? ((withContact / completed) * 100).toFixed(1) : '0.0',
    meetingRate: withContact > 0 ? ((meetings / withContact) * 100).toFixed(1) : '0.0',
    scoreDist,
    utmSources,
    utmCampaigns,
    series: Object.values(seriesMap),
    recentLeads: filtered.slice(-50).reverse()
  };
}

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Webhook-Secret'] }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'ScoreApp Webhook Server',
    leads: store.leads.length,
    lastUpdated: store.lastUpdated,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

app.post('/webhook/scoreapp', (req, res) => {
  if (WEBHOOK_SECRET) {
    const provided = req.headers['x-webhook-secret'] || req.body?.secret;
    if (provided !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }

  const p = req.body;
  console.log('Webhook modtaget:', JSON.stringify(p).substring(0, 300));

  const lead = {
    id:          p.id || p.submission_id || Date.now().toString(),
    receivedAt:  new Date().toISOString(),

    // Kontaktinfo
    name:        p.name || p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Ukendt',
    email:       p.email || p.contact_email || '',
    phone:       p.phone || p.contact_phone || '',
    company:     p.company || p.company_name || p.organisation || '',

    // UTM — prioriteret rækkefølge
    utmSource:   p.utm_source   || p.utmSource   || p.source   || '',
    utmMedium:   p.utm_medium   || p.utmMedium   || p.medium   || '',
    utmCampaign: p.utm_campaign || p.utmCampaign || p.campaign || '',
    utmContent:  p.utm_content  || p.utmContent  || p.content  || '',
    utmTerm:     p.utm_term     || p.utmTerm     || p.term     || '',

    // Kilde (fallback hvis ingen UTM)
    source:      p.utm_source || p.source || 'ScoreApp',

    // Score (valgfrit)
    score:         parseInt(p.score || p.total_score || 0) || null,
    scoreLabel:    p.score_label || p.result_label || '',
    scoreCategory: p.score ? categorizeScore(parseInt(p.score)) : '',

    // Møde
    meetingBooked: p.meeting_booked === true || p.meeting_booked === 'true' || false,

    raw: p
  };

  store.leads.push(lead);
  store.lastUpdated = new Date().toISOString();
  saveData();

  console.log('Lead gemt: ' + lead.name + ' | UTM: ' + lead.utmSource + '/' + lead.utmCampaign);
  res.status(200).json({ success: true, id: lead.id });
});

app.get('/api/stats', (req, res) => {
  const period = req.query.period || 'maaned';
  const days = period === 'dag' ? 1 : period === 'uge' ? 7 : period === 'maaned' ? 30 : 0;
  const stats = calcStats(store.leads, days);
  res.json({ ok: true, period, lastUpdated: store.lastUpdated, totalLeads: store.leads.length, stats });
});

app.get('/api/leads', (req, res) => {
  const limit  = parseInt(req.query.limit)  || 50;
  const offset = parseInt(req.query.offset) || 0;
  res.json({ ok: true, total: store.leads.length, leads: store.leads.slice().reverse().slice(offset, offset + limit) });
});

app.delete('/api/leads', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  store.leads = [];
  store.lastUpdated = new Date().toISOString();
  saveData();
  res.json({ ok: true, message: 'Alle leads slettet' });
});

app.post('/api/test-lead', (req, res) => {
  const sources = ['linkedin', 'meta', 'google', 'email'];
  const campaigns = ['lead-gen-q1', 'retargeting-feb', 'brand-awareness', 'webinar-2026'];
  const mediums = ['cpc', 'social', 'email', 'organic'];
  const src = sources[Math.floor(Math.random() * sources.length)];
  const camp = campaigns[Math.floor(Math.random() * campaigns.length)];
  const med = mediums[Math.floor(Math.random() * mediums.length)];

  const lead = {
    id:          'test-' + Date.now(),
    receivedAt:  new Date().toISOString(),
    name:        'Test Person',
    email:       'test@example.com',
    phone:       '',
    company:     'Test Virksomhed A/S',
    utmSource:   src,
    utmMedium:   med,
    utmCampaign: camp,
    utmContent:  'annonce-variant-a',
    utmTerm:     '',
    source:      src,
    score:       null,
    scoreLabel:  '',
    scoreCategory: '',
    meetingBooked: false,
    raw: {}
  };

  store.leads.push(lead);
  store.lastUpdated = new Date().toISOString();
  saveData();
  res.json({ ok: true, message: 'Test-lead tilføjet', lead });
});

function categorizeScore(score) {
  if (score >= 80) return 'Klar til køb';
  if (score >= 60) return 'Overvejer';
  if (score >= 40) return 'Tidlig fase';
  return 'Ikke klar';
}

loadData();
app.listen(PORT, () => {
  console.log('ScoreApp Webhook Server kører på port ' + PORT);
  console.log('Webhook URL: POST /webhook/scoreapp');
  console.log('Stats URL:   GET  /api/stats');
  console.log('Leads URL:   GET  /api/leads');
});
