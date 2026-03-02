const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;
const DATA_FILE = path.join(__dirname, 'data.json');

// ── Store: leads gemmes med scorecard-id ──
let store = {
  leads:       [],   // Alle leads på tværs af scorecards
  lastUpdated: null
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
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
    console.warn('Kunne ikke gemme:', e.message);
  }
}

// ── Hent liste over unikke scorecards ──
function getScorecards() {
  const map = {};
  store.leads.forEach(l => {
    const id = l.scorecardId || 'default';
    const name = l.scorecardName || id;
    if (!map[id]) map[id] = { id, name, count: 0 };
    map[id].count++;
  });
  return Object.values(map);
}

// ── Beregn statistik ──
function calcStats(leads, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const filtered = days === 0 ? leads : leads.filter(l => new Date(l.receivedAt) >= cutoff);

  const completed   = filtered.length;
  const withContact = filtered.filter(l => l.email || l.phone).length;
  const meetings    = filtered.filter(l => l.meetingBooked === true).length;

  const utmSources = {};
  const utmCampaigns = {};
  const utmMediums = {};
  filtered.forEach(l => {
    const src  = l.utmSource   || l.source || 'Direkte';
    const camp = l.utmCampaign || 'Ingen kampagne';
    const med  = l.utmMedium   || 'Ukendt';
    utmSources[src]    = (utmSources[src]    || 0) + 1;
    utmCampaigns[camp] = (utmCampaigns[camp] || 0) + 1;
    utmMediums[med]    = (utmMediums[med]    || 0) + 1;
  });

  const scoreDist = { 'Under 40': 0, '40–59': 0, '60–79': 0, '80–100': 0 };
  filtered.forEach(l => {
    const s = parseInt(l.score) || 0;
    if (s < 40) scoreDist['Under 40']++;
    else if (s < 60) scoreDist['40–59']++;
    else if (s < 80) scoreDist['60–79']++;
    else scoreDist['80–100']++;
  });

  const seriesMap = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    seriesMap[d.toISOString().split('T')[0]] = 0;
  }
  filtered.forEach(l => {
    const key = l.receivedAt ? l.receivedAt.split('T')[0] : null;
    if (key && key in seriesMap) seriesMap[key]++;
  });

  return {
    completed, leads: withContact, meetings,
    completionRate: completed > 0 ? ((completed / Math.max(completed * 1.8, 1)) * 100).toFixed(1) : '0.0',
    leadRate:       completed > 0 ? ((withContact / completed) * 100).toFixed(1) : '0.0',
    meetingRate:    withContact > 0 ? ((meetings / withContact) * 100).toFixed(1) : '0.0',
    scoreDist, utmSources, utmCampaigns, utmMediums,
    series: Object.values(seriesMap),
    recentLeads: filtered.slice(-50).reverse()
  };
}

function normalizeLead(p, scorecardId, scorecardName) {
  return {
    id:            p.id || p.submission_id || Date.now().toString() + Math.random().toString(36).slice(2,6),
    receivedAt:    p.receivedAt || p.created_at || p.submitted_at || new Date().toISOString(),
    scorecardId:   scorecardId  || p.scorecard_id   || 'default',
    scorecardName: scorecardName || p.scorecard_name || scorecardId || 'Standard',
    name:          p.name || p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Ukendt',
    email:         p.email || p.contact_email || '',
    phone:         p.phone || p.contact_phone || '',
    company:       p.company || p.company_name || p.organisation || '',
    utmSource:     p.utm_source   || p.utmSource   || p.source   || '',
    utmMedium:     p.utm_medium   || p.utmMedium   || p.medium   || '',
    utmCampaign:   p.utm_campaign || p.utmCampaign || p.campaign || '',
    utmContent:    p.utm_content  || p.utmContent  || p.content  || '',
    utmTerm:       p.utm_term     || p.utmTerm     || p.term     || '',
    source:        p.utm_source   || p.source       || 'ScoreApp',
    score:         parseInt(p.score || p.total_score || 0) || null,
    scoreLabel:    p.score_label  || p.result_label  || '',
    scoreCategory: p.score ? categorizeScore(parseInt(p.score)) : '',
    meetingBooked: p.meeting_booked === true || p.meeting_booked === 'true' || false,
    imported:      p.imported || false
  };
}

function categorizeScore(s) {
  if (s >= 80) return 'Klar til køb';
  if (s >= 60) return 'Overvejer';
  if (s >= 40) return 'Tidlig fase';
  return 'Ikke klar';
}

// ══════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','X-Webhook-Secret','X-Scorecard-Id','X-Scorecard-Name'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ══════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status: 'online', service: 'ScoreApp Webhook Server (multi-scorecard)',
    totalLeads: store.leads.length,
    scorecards: getScorecards(),
    lastUpdated: store.lastUpdated,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// ── Webhook: modtager live leads fra ScoreApp via Make ──
// Understøtter scorecard-id i URL: /webhook/scoreapp/beredskabsplan
app.post('/webhook/scoreapp/:scorecardId?', (req, res) => {
  if (WEBHOOK_SECRET) {
    const provided = req.headers['x-webhook-secret'] || req.body?.secret;
    if (provided !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }

  const scorecardId   = req.params.scorecardId || req.headers['x-scorecard-id'] || req.body?.scorecard_id || 'default';
  const scorecardName = req.headers['x-scorecard-name'] || req.body?.scorecard_name || scorecardId;

  const lead = normalizeLead(req.body, scorecardId, scorecardName);
  store.leads.push(lead);
  store.lastUpdated = new Date().toISOString();
  saveData();

  console.log('[' + scorecardId + '] Lead: ' + lead.name + ' | ' + lead.utmSource + '/' + lead.utmCampaign);
  res.status(200).json({ success: true, id: lead.id, scorecardId });
});

// ── Bulk import: indsend historiske leads som JSON-array ──
app.post('/api/import', (req, res) => {
  if (WEBHOOK_SECRET) {
    const provided = req.headers['x-webhook-secret'];
    if (provided !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }

  const { leads, scorecardId, scorecardName, overwrite } = req.body;
  if (!Array.isArray(leads)) return res.status(400).json({ error: 'leads skal være et array' });

  // Overwrite: slet eksisterende leads for dette scorecard
  if (overwrite) {
    store.leads = store.leads.filter(l => l.scorecardId !== (scorecardId || 'default'));
  }

  // Undgå dubletter baseret på email + dato
  const existingKeys = new Set(store.leads.map(l => (l.email || l.id) + '_' + (l.receivedAt || '').split('T')[0]));
  let imported = 0, skipped = 0;

  leads.forEach(raw => {
    const lead = normalizeLead(raw, scorecardId || 'default', scorecardName || scorecardId || 'Importeret');
    lead.imported = true;
    const key = (lead.email || lead.id) + '_' + lead.receivedAt.split('T')[0];
    if (existingKeys.has(key)) { skipped++; return; }
    existingKeys.add(key);
    store.leads.push(lead);
    imported++;
  });

  // Sortér alle leads efter dato
  store.leads.sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
  store.lastUpdated = new Date().toISOString();
  saveData();

  console.log('Import: ' + imported + ' nye leads, ' + skipped + ' dubletter sprunget over');
  res.json({ ok: true, imported, skipped, total: store.leads.length });
});

// ── Stats: med valgfrit scorecard-filter ──
app.get('/api/stats', (req, res) => {
  const period      = req.query.period      || 'maaned';
  const scorecardId = req.query.scorecardId || null;
  const days = period === 'dag' ? 1 : period === 'uge' ? 7 : period === 'maaned' ? 30 : 0;

  const leads = scorecardId
    ? store.leads.filter(l => l.scorecardId === scorecardId)
    : store.leads;

  const stats = calcStats(leads, days);
  res.json({
    ok: true, period, scorecardId: scorecardId || 'alle',
    lastUpdated: store.lastUpdated,
    totalLeads: store.leads.length,
    filteredLeads: leads.length,
    scorecards: getScorecards(),
    stats
  });
});

// ── Leads: med valgfrit scorecard-filter ──
app.get('/api/leads', (req, res) => {
  const limit       = parseInt(req.query.limit)  || 50;
  const offset      = parseInt(req.query.offset) || 0;
  const scorecardId = req.query.scorecardId || null;

  const leads = scorecardId
    ? store.leads.filter(l => l.scorecardId === scorecardId)
    : store.leads;

  res.json({ ok: true, total: leads.length, leads: leads.slice().reverse().slice(offset, offset + limit) });
});

// ── Scorecards liste ──
app.get('/api/scorecards', (req, res) => {
  res.json({ ok: true, scorecards: getScorecards() });
});

// ── Slet leads (alt eller pr. scorecard) ──
app.delete('/api/leads', (req, res) => {
  if (WEBHOOK_SECRET) {
    if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }
  const scorecardId = req.query.scorecardId || null;
  if (scorecardId) {
    const before = store.leads.length;
    store.leads = store.leads.filter(l => l.scorecardId !== scorecardId);
    console.log('Slettede ' + (before - store.leads.length) + ' leads fra ' + scorecardId);
  } else {
    store.leads = [];
  }
  store.lastUpdated = new Date().toISOString();
  saveData();
  res.json({ ok: true, remaining: store.leads.length });
});

// ── Test-lead ──
app.post('/api/test-lead', (req, res) => {
  const scorecardId   = req.body?.scorecardId   || 'default';
  const scorecardName = req.body?.scorecardName || 'Test Scorecard';
  const sources   = ['linkedin','meta','google','email','direkte'];
  const campaigns = ['lead-gen-q1','retargeting-feb','brand-awareness','webinar-2026'];
  const mediums   = ['cpc','social','email','organic'];
  const lead = normalizeLead({
    name: 'Test Person', email: 'test@example.com', company: 'Test Virksomhed A/S',
    utm_source:   sources[Math.floor(Math.random()*sources.length)],
    utm_medium:   mediums[Math.floor(Math.random()*mediums.length)],
    utm_campaign: campaigns[Math.floor(Math.random()*campaigns.length)],
    score: Math.floor(Math.random()*60)+40
  }, scorecardId, scorecardName);
  store.leads.push(lead);
  store.lastUpdated = new Date().toISOString();
  saveData();
  res.json({ ok: true, message: 'Test-lead tilføjet til ' + scorecardId, lead });
});

loadData();
app.listen(PORT, () => {
  console.log('ScoreApp Webhook Server (multi-scorecard) kører på port ' + PORT);
  console.log('Webhook:  POST /webhook/scoreapp/:scorecardId');
  console.log('Import:   POST /api/import');
  console.log('Stats:    GET  /api/stats?period=maaned&scorecardId=xxx');
  console.log('Scorecards: GET /api/scorecards');
});
