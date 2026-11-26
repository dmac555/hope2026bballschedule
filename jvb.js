'use strict';

const PROJECT_URL = 'https://ffkqgkxxykoxztvigxzd.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_StmzzSlgrhDeLbL5_lPfIw_5lYdzXpG';
const SCHEDULE_MONTHS = [
  { year: 2026, month: 10 },
  { year: 2026, month: 11 },
  { year: 2027, month: 0 },
  { year: 2027, month: 1 }
];

let client;
let calendarClient;
let account;
let roster = [];
let activeView = 'calendar';
let monthIndex = 0;
let refreshTimer;
let requestVersion = 0;
let renderedMessagesKey = '';
let availabilityVersion = 0;
let availabilityEventId = null;
let myAvailability = null;

function showStatus(id, message) {
  const element = document.getElementById(id);
  element.textContent = message;
  element.hidden = !message;
}

async function getAccount() {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session) return null;
  const { data, error } = await client.rpc('hope_jvb_session');
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function signIn(event) {
  event.preventDefault();
  const button = document.getElementById('loginButton');
  const lastName = document.getElementById('lastName').value.trim();
  const accountCode = document.getElementById('accountCode').value;
  showStatus('loginError', '');
  button.disabled = true;
  try {
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    if (!sessionData.session) {
      const { error } = await client.auth.signInAnonymously();
      if (error) throw error;
    }
    const { data, error } = await client.rpc('hope_jvb_sign_in', { last_name: lastName, account_code: accountCode });
    if (error) throw error;
    if (!data) {
      showStatus('loginError', 'Last name or account code not recognized.');
      return;
    }
    window.location.replace('./jvb.html');
  } catch (error) {
    console.error('JVB sign-in failed:', error);
    showStatus('loginError', 'Unable to sign in. Team access may not be set up yet.');
  } finally {
    document.getElementById('accountCode').value = '';
    button.disabled = false;
  }
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getEventTimeRange(eventItem) {
  const match = (eventItem.time || '').match(/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?(?:\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (!match) return { start: -1, end: -1 };
  const startPeriod = (match[3] || match[6] || 'PM').toUpperCase();
  const endPeriod = (match[6] || match[3] || startPeriod).toUpperCase();
  const toMinutes = (hour, minute, period) => (Number(hour) % 12 + (period === 'PM' ? 12 : 0)) * 60 + Number(minute || 0);
  const start = toMinutes(match[1], match[2], startPeriod);
  let end = match[4] ? toMinutes(match[4], match[5], endPeriod) : Infinity;
  if (end < start) end += 24 * 60;
  return { start, end };
}

function displayTitle(eventItem) {
  return eventItem.category === 'PRACTICE' && eventItem.date.slice(5, 7) === '12'
    ? eventItem.title.replace(/\s*\*+\s*$/, '').trim()
    : eventItem.title;
}

function setAvailabilityBusy(busy) {
  document.getElementById('attendingButton').disabled = busy || account.is_coach;
  document.getElementById('notAttendingButton').disabled = busy || account.is_coach;
}

async function loadAvailability(version, eventId) {
  try {
    const { data, error } = await client.rpc('hope_jvb_get_availability', { p_event_id: eventId });
    if (error) throw error;
    if (version !== availabilityVersion) return;
    if (!data || !data[0]) throw new Error('Missing availability totals');
    const totals = data[0];
    myAvailability = totals.my_attending;
    document.getElementById('attendingCount').textContent = totals.attending_count;
    document.getElementById('notAttendingCount').textContent = totals.not_attending_count;
    document.getElementById('attendingButton').setAttribute('aria-pressed', String(myAvailability === true));
    document.getElementById('notAttendingButton').setAttribute('aria-pressed', String(myAvailability === false));
    showStatus('availabilityStatus', account.is_coach ? 'Player responses only.' : '');
    setAvailabilityBusy(false);
  } catch (error) {
    console.error('JVB availability failed:', error);
    if (version === availabilityVersion) {
      showStatus('availabilityStatus', 'Unable to load availability. Close and reopen this event to retry.');
      setAvailabilityBusy(true);
    }
  }
}

async function setAvailability(attending) {
  const version = availabilityVersion;
  const eventId = availabilityEventId;
  setAvailabilityBusy(true);
  showStatus('availabilityStatus', 'Saving...');
  try {
    const { error } = await client.rpc('hope_jvb_set_availability', { p_event_id: eventId, p_attending: myAvailability === attending ? null : attending });
    if (error) throw error;
    if (version === availabilityVersion) await loadAvailability(version, eventId);
  } catch (error) {
    console.error('JVB availability update failed:', error);
    if (version === availabilityVersion) {
      showStatus('availabilityStatus', 'Unable to save availability. Please try again.');
      setAvailabilityBusy(false);
    }
  }
}

function showEvent(eventItem) {
  document.getElementById('eventTitle').textContent = displayTitle(eventItem);
  const details = document.getElementById('eventDetails');
  details.replaceChildren();
  const date = new Date(`${eventItem.date}T12:00:00`);
  const categoryLabels = { HOME: 'Home', AWAY: 'Away', PRACTICE: 'Practice', EVENT: 'Event' };
  const fields = [
    ['Date', date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })],
    ['Time', eventItem.time],
    ['Category', categoryLabels[eventItem.category] || eventItem.category],
    ['Location', (eventItem.location || '').replace(/\bLiberty\b/gi, 'GMMS')],
    ['Notes', eventItem.details]
  ];
  fields.forEach(([label, value]) => {
    if (!value) return;
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    details.append(term, description);
  });
  availabilityEventId = eventItem.id;
  const version = ++availabilityVersion;
  myAvailability = null;
  document.getElementById('attendingCount').textContent = '--';
  document.getElementById('notAttendingCount').textContent = '--';
  document.getElementById('attendingButton').setAttribute('aria-pressed', 'false');
  document.getElementById('notAttendingButton').setAttribute('aria-pressed', 'false');
  setAvailabilityBusy(true);
  showStatus('availabilityStatus', 'Loading availability...');
  document.getElementById('eventDialog').showModal();
  loadAvailability(version, eventItem.id);
}

async function renderCalendar() {
  const { year, month } = SCHEDULE_MONTHS[monthIndex];
  const monthDate = new Date(year, month, 1);
  const firstDay = new Date(year, month, 1 - monthDate.getDay());
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((monthDate.getDay() + daysInMonth) / 7) * 7;
  const lastDay = new Date(year, month, cellCount - monthDate.getDay());
  const grid = document.getElementById('calendarGrid');
  document.getElementById('monthTitle').textContent = monthDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  document.getElementById('previousMonth').disabled = monthIndex === 0;
  document.getElementById('nextMonth').disabled = monthIndex === SCHEDULE_MONTHS.length - 1;
  grid.replaceChildren();
  showStatus('calendarStatus', 'Loading schedule…');
  const version = ++requestVersion;
  try {
    const { data, error } = await calendarClient.from('calendar_events')
      .select('id,date,title,time,category,location,details')
      .gte('date', formatDate(firstDay))
      .lte('date', formatDate(lastDay));
    if (error) throw error;
    if (version !== requestVersion) return;
    const events = (data || []).filter(eventItem =>
      `${eventItem.title || ''} ${eventItem.details || ''}`.toUpperCase().includes('HOPE JVB')
    );
    events.sort((firstEvent, secondEvent) => {
      const firstTime = getEventTimeRange(firstEvent);
      const secondTime = getEventTimeRange(secondEvent);
      return firstTime.start - secondTime.start || firstTime.end - secondTime.end || 0;
    });
    for (let index = 0; index < cellCount; index++) {
      const date = new Date(year, month, index + 1 - monthDate.getDay());
      const dateString = formatDate(date);
      const cell = document.createElement('div');
      cell.className = date.getMonth() === month ? 'day' : 'day outside';
      const dayNumber = document.createElement('span');
      dayNumber.className = 'day-number';
      dayNumber.textContent = String(date.getDate());
      cell.appendChild(dayNumber);
      events.filter(eventItem => eventItem.date === dateString).forEach(eventItem => {
        const eventButton = document.createElement('button');
        eventButton.type = 'button';
        eventButton.className = `event ${eventItem.category === 'AWAY' ? 'away' : eventItem.category === 'PRACTICE' ? 'practice' : ''}`;
        const title = displayTitle(eventItem);
        eventButton.textContent = title.replace(/^Hope JVB:\s*/i, '').replace(/\bHope JVB(?=\s*[@v])/i, '').trim();
        eventButton.setAttribute('aria-label', title);
        eventButton.addEventListener('click', () => showEvent(eventItem));
        cell.appendChild(eventButton);
      });
      grid.appendChild(cell);
    }
    showStatus('calendarStatus', '');
  } catch (error) {
    console.error('JVB calendar failed:', error);
    if (version === requestVersion) showStatus('calendarStatus', 'Unable to load the schedule.');
  }
}

function selectedParticipant() {
  return account.is_coach ? document.getElementById('conversationSelect').value : account.account_id;
}

function updateChatRecipient() {
  const recipient = document.getElementById('chatRecipient');
  recipient.hidden = activeView !== 'direct';
  if (activeView === 'direct') {
    const player = roster.find(member => member.account_id === selectedParticipant());
    recipient.textContent = account.is_coach ? (player ? player.display_name : '') : 'Coach';
  }
}

async function renderMessages() {
  const channel = activeView;
  if (channel !== 'team' && channel !== 'direct') return;
  const participant = channel === 'direct' ? selectedParticipant() : null;
  const messageList = document.getElementById('messages');
  if (channel === 'direct' && !participant) {
    messageList.replaceChildren();
    showStatus('chatStatus', 'No player selected.');
    return;
  }
  const version = ++requestVersion;
  try {
    let query = client.from('hope_jvb_messages')
      .select('id,channel,participant_id,sender_id,body,created_at')
      .eq('channel', channel);
    if (participant) query = query.eq('participant_id', participant);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    if (version !== requestVersion) return;
    const messages = (data || []).slice().reverse();
    const messagesKey = `${channel}:${participant || ''}:${messages.map(message => message.id).join(',')}`;
    if (messagesKey === renderedMessagesKey) {
      showStatus('chatStatus', messages.length ? '' : 'No messages yet.');
      return;
    }
    renderedMessagesKey = messagesKey;
    const isNearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 60;
    messageList.replaceChildren();
    messages.forEach(message => {
      const wrapper = document.createElement('div');
      wrapper.className = message.sender_id === account.account_id ? 'message mine' : 'message';
      const meta = document.createElement('p');
      meta.className = 'message-meta';
      const sender = roster.find(member => member.account_id === message.sender_id);
      const sentAt = new Date(message.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      meta.textContent = `${sender ? sender.display_name : 'Team member'} · ${sentAt}`;
      const body = document.createElement('p');
      body.className = 'message-body';
      body.textContent = message.body;
      wrapper.append(meta, body);
      messageList.appendChild(wrapper);
    });
    if (isNearBottom) messageList.scrollTop = messageList.scrollHeight;
    showStatus('chatStatus', data && data.length ? '' : 'No messages yet.');
  } catch (error) {
    console.error('JVB messages failed:', error);
    if (version === requestVersion) showStatus('chatStatus', 'Unable to load messages.');
  }
}

function setView(view) {
  activeView = view;
  requestVersion++;
  renderedMessagesKey = '';
  document.querySelectorAll('.tab').forEach(button => {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.getElementById('calendarView').hidden = view !== 'calendar';
  document.getElementById('chatView').hidden = view === 'calendar';
  if (view === 'calendar') {
    renderCalendar();
    return;
  }
  document.getElementById('chatTitle').textContent = view === 'team' ? 'Team Chat' : 'Individual Chat';
  document.getElementById('conversationControl').hidden = view !== 'direct' || !account.is_coach;
  updateChatRecipient();
  document.getElementById('messages').replaceChildren();
  renderMessages();
}

async function sendMessage(event) {
  event.preventDefault();
  const input = document.getElementById('messageInput');
  const body = input.value.trim();
  const channel = activeView;
  const participant = channel === 'direct' ? selectedParticipant() : null;
  if (!body || (channel !== 'team' && channel !== 'direct') || (channel === 'direct' && !participant)) return;
  const button = document.getElementById('sendMessage');
  button.disabled = true;
  try {
    const { error } = await client.from('hope_jvb_messages').insert({ channel, participant_id: participant, body });
    if (error) throw error;
    input.value = '';
    await renderMessages();
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
  } catch (error) {
    console.error('JVB message send failed:', error);
    showStatus('chatStatus', 'Unable to send your message. Please try again.');
  } finally {
    button.disabled = false;
  }
}

async function initializeTeam() {
  account = await getAccount();
  if (!account) {
    window.location.replace('./jvb-login.html');
    return;
  }
  const { data, error } = await client.rpc('hope_jvb_roster');
  if (error) throw error;
  roster = data || [];
  document.getElementById('accountName').textContent = account.display_name;
  const select = document.getElementById('conversationSelect');
  roster.filter(member => !member.is_coach).forEach(member => {
    const option = document.createElement('option');
    option.value = member.account_id;
    option.textContent = member.display_name;
    select.appendChild(option);
  });
  select.addEventListener('change', () => { renderedMessagesKey = ''; updateChatRecipient(); document.getElementById('messages').replaceChildren(); renderMessages(); });
  document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  document.getElementById('previousMonth').addEventListener('click', () => { if (monthIndex > 0) { monthIndex--; renderCalendar(); } });
  document.getElementById('nextMonth').addEventListener('click', () => { if (monthIndex < SCHEDULE_MONTHS.length - 1) { monthIndex++; renderCalendar(); } });
  document.getElementById('attendingButton').addEventListener('click', () => setAvailability(true));
  document.getElementById('notAttendingButton').addEventListener('click', () => setAvailability(false));
  document.getElementById('eventDialog').addEventListener('close', () => { availabilityVersion++; availabilityEventId = null; });
  document.getElementById('messageForm').addEventListener('submit', sendMessage);
  document.getElementById('signOut').addEventListener('click', async () => {
    window.clearInterval(refreshTimer);
    await client.auth.signOut();
    window.location.replace('./jvb-login.html');
  });
  const today = new Date();
  const currentMonth = SCHEDULE_MONTHS.findIndex(item => item.year === today.getFullYear() && item.month === today.getMonth());
  monthIndex = currentMonth < 0 ? 0 : currentMonth;
  document.getElementById('loadingStatus').hidden = true;
  document.getElementById('app').hidden = false;
  await renderCalendar();
  refreshTimer = window.setInterval(() => { if (!document.hidden && activeView !== 'calendar') renderMessages(); }, 8000);
}

async function initialize() {
  try {
    client = window.supabase.createClient(PROJECT_URL, PUBLISHABLE_KEY, { auth: { storageKey: 'hope-jvb-auth-v1' } });
    calendarClient = window.supabase.createClient(PROJECT_URL, PUBLISHABLE_KEY, {
      auth: { storageKey: 'hope-jvb-calendar-v1', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    if (document.body.dataset.page === 'login') {
      document.getElementById('loginForm').addEventListener('submit', signIn);
      if (await getAccount()) window.location.replace('./jvb.html');
    } else {
      await initializeTeam();
    }
  } catch (error) {
    console.error('JVB initialization failed:', error);
    if (document.body.dataset.page === 'login') {
      showStatus('loginError', 'Unable to connect. Team access may not be set up yet.');
    } else {
      document.getElementById('loadingStatus').textContent = 'Unable to load JVB. Team access may not be set up yet.';
    }
  }
}

initialize();
