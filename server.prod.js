const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '.')));

// ─── In-memory state ───────────────────────────────────────────
let botState = { running: false, grabbed: 0, earned: 0, checked: 0, log: [], offers: [] };

let filters = {
  stations: ['SEA5', 'DWA3'],
  minPay: 30,
  maxHours: 4,
  startTime: '07:00',
  endTime: '20:00',
  blockType: 'both',
};

let flexToken = null;
let pollInterval = null;

function addLog(msg, color = '#888780') {
  botState.log.unshift({ msg, color, time: new Date().toISOString() });
  if (botState.log.length > 100) botState.log.pop();
}

function timeInWindow(offerTime) {
  if (!filters.startTime || !filters.endTime) return true;
  const [sh, sm] = filters.startTime.split(':').map(Number);
  const [eh, em] = filters.endTime.split(':').map(Number);
  const [oh, om] = offerTime.split(':').map(Number);
  return (oh * 60 + om) >= (sh * 60 + sm) && (oh * 60 + om) <= (eh * 60 + em);
}

function matchesFilters(offer) {
  if (offer.pay < filters.minPay) return false;
  if (offer.durationHours > filters.maxHours) return false;
  if (filters.stations.length > 0 && !filters.stations.some(s => offer.stationCode.includes(s.trim()))) return false;
  if (filters.blockType === 'instant' && offer.type !== 'instant') return false;
  if (filters.blockType === 'scheduled' && offer.type !== 'scheduled') return false;
  if (!timeInWindow(offer.startTime)) return false;
  return true;
}

async function fetchOffersFromAmazon() {
  if (!flexToken) return getMockOffers();
  try {
    const response = await axios.get(
      'https://flex-capacity-na.amazon.com/v0/offersForLocation',
      {
        headers: {
          Authorization: `Bearer ${flexToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        },
        params: { eligibleServiceTypes: 'FLEX,SCHEDULED' },
        timeout: 8000,
      }
    );
    const raw = response.data?.offerList || [];
    return raw.map(o => ({
      id: o.offerId,
      stationCode: o.serviceAreaIds?.[0] || 'UNKNOWN',
      station: o.serviceAreaNames?.[0] || 'Unknown Station',
      pay: parseFloat(o.rateInfo?.priceAmount || 0),
      durationHours: (o.offerDuration || 10800) / 3600,
      startTime: o.startTime ? new Date(o.startTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '??:??',
      endTime: o.endTime ? new Date(o.endTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '??:??',
      type: o.offerType === 'Flex' ? 'instant' : 'scheduled',
    }));
  } catch (err) {
    addLog(`API error: ${err.message}`, '#E24B4A');
    return [];
  }
}

async function acceptOffer(offerId) {
  if (!flexToken) { addLog(`[Demo] Accepted ${offerId}`, '#FF9900'); return true; }
  try {
    await axios.post('https://flex-capacity-na.amazon.com/v0/acceptOffer', { offerId }, {
      headers: { Authorization: `Bearer ${flexToken}`, 'Content-Type': 'application/json' },
      timeout: 8000,
    });
    return true;
  } catch (err) {
    addLog(`Accept failed: ${err.message}`, '#E24B4A');
    return false;
  }
}

const STATIONS = [
  {code:'SEA5',name:'SEA5 — Kent, WA'},{code:'DWA3',name:'DWA3 — Renton, WA'},
  {code:'SEA8',name:'SEA8 — Tukwila, WA'},{code:'DWA5',name:'DWA5 — Auburn, WA'},
  {code:'WFM1',name:'Whole Foods — Bellevue'},
];

function getMockOffers() {
  const count = Math.floor(Math.random() * 3) + 1;
  return Array.from({ length: count }, (_, i) => {
    const st = STATIONS[Math.floor(Math.random() * STATIONS.length)];
    const pay = [28,33,38,45,52,64,72][Math.floor(Math.random()*7)];
    const hrs = [2,3,3,4,4,5][Math.floor(Math.random()*6)];
    const startHr = 7 + Math.floor(Math.random()*10);
    return { id:`mock_${Date.now()}_${i}`, stationCode:st.code, station:st.name, pay, durationHours:hrs,
      startTime:`${startHr}:00`, endTime:`${startHr+hrs}:00`, type:Math.random()>.4?'instant':'scheduled' };
  });
}

async function botTick() {
  if (!botState.running) return;
  const offers = await fetchOffersFromAmazon();
  botState.checked += offers.length;
  const matched = offers.filter(matchesFilters);
  if (matched.length) {
    addLog(`Found ${matched.length} matching offer(s)`, '#1D9E75');
    for (const offer of matched) {
      const ok = await acceptOffer(offer.id);
      if (ok) { botState.grabbed++; botState.earned += offer.pay; addLog(`Grabbed: ${offer.station} — $${offer.pay} / ${offer.durationHours}h`, '#FF9900'); }
    }
  } else {
    addLog(`Scanned ${offers.length} offer(s) — no match`, '#888780');
  }
  botState.offers = offers;
}

// Routes
app.post('/api/auth', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  flexToken = token;
  addLog('Flex account connected', '#1D9E75');
  res.json({ success: true });
});

app.post('/api/bot/start', (req, res) => {
  if (botState.running) return res.json({ running: true });
  botState.running = true;
  addLog('Bot started — scanning for offers', '#1D9E75');
  pollInterval = setInterval(botTick, 4000);
  botTick();
  res.json({ running: true });
});

app.post('/api/bot/stop', (req, res) => {
  botState.running = false;
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  addLog('Bot paused', '#BA7517');
  res.json({ running: false });
});

app.get('/api/state', (req, res) => res.json(botState));
app.get('/api/offers', (req, res) => res.json(botState.offers));

app.post('/api/offers/accept', async (req, res) => {
  const { offerId } = req.body;
  const offer = botState.offers.find(o => o.id === offerId);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  const ok = await acceptOffer(offerId);
  if (ok) {
    botState.grabbed++; botState.earned += offer.pay;
    botState.offers = botState.offers.filter(o => o.id !== offerId);
    addLog(`Manual accept: ${offer.station} — $${offer.pay}`, '#FF9900');
    res.json({ success: true });
  } else { res.status(500).json({ error: 'Accept failed' }); }
});

app.post('/api/filters', (req, res) => {
  const { stations, minPay, maxHours, startTime, endTime, blockType } = req.body;
  if (stations !== undefined) filters.stations = typeof stations === 'string' ? stations.split(',').map(s=>s.trim()) : stations;
  if (minPay !== undefined) filters.minPay = Number(minPay);
  if (maxHours !== undefined) filters.maxHours = Number(maxHours);
  if (startTime !== undefined) filters.startTime = startTime;
  if (endTime !== undefined) filters.endTime = endTime;
  if (blockType !== undefined) filters.blockType = blockType;
  addLog('Preferences saved', '#1D9E75');
  res.json({ success: true, filters });
});

app.get('/api/filters', (req, res) => res.json(filters));
app.post('/api/reset', (req, res) => {
  botState.grabbed=0; botState.earned=0; botState.checked=0; botState.log=[];
  addLog('Stats reset', '#888780');
  res.json({ success: true });
});
app.get('/health', (req, res) => res.json({ status: 'ok', demo: !flexToken }));

// Catch-all: serve frontend
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/public/index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`FlexGrabber running on http://localhost:${PORT}`));
