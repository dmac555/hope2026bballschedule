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
let selectedMessage = null;
let pushRegistration = null;
let pushPublicKey = null;

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
    const { data, error } = await client.rpc('hope_jvb_get_availability_details', { p_event_id: eventId });
    if (error) throw error;
    if (version !== availabilityVersion) return;
    if (!data || !data[0]) throw new Error('Missing availability totals');
    const totals = data[0];
    myAvailability = totals.my_attending;
    document.getElementById('attendingCount').textContent = totals.attending_count;
    document.getElementById('notAttendingCount').textContent = totals.not_attending_count;
    document.getElementById('attendingNames').textContent = totals.attending_names.join(', ') || 'None yet';
    document.getElementById('notAttendingNames').textContent = totals.not_attending_names.join(', ') || 'None yet';
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
  document.getElementById('attendingNames').textContent = '';
  document.getElementById('notAttendingNames').textContent = '';
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

function updateNotificationButton(enabled) {
  const button = document.getElementById('notificationToggle');
  const label = enabled ? 'Notifications on. Disable notifications' : 'Notifications off. Enable notifications';
  button.dataset.state = enabled ? 'on' : 'off';
  document.getElementById('notificationToggleLabel').textContent = enabled ? 'ON' : 'OFF';
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', label);
  button.title = label;
}

async function getPushPublicKey() {
  if (pushPublicKey) return pushPublicKey;
  const { data, error } = await client.functions.invoke('hope-jvb-push', { body: { action: 'public-key' } });
  if (error || !data?.publicKey) throw error || new Error('Push key unavailable');
  pushPublicKey = data.publicKey;
  return pushPublicKey;
}

function decodePushKey(key) {
  const padded = (key + '='.repeat((4 - key.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

async function initializeNotifications() {
  const button = document.getElementById('notificationToggle');
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    pushRegistration = await navigator.serviceWorker.register('./jvb-push-sw.js', { scope: './jvb' });
    await navigator.serviceWorker.ready;
    const subscription = await pushRegistration.pushManager.getSubscription();
    if (subscription) {
      const { error } = await client.rpc('hope_jvb_register_push', { p_subscription: subscription.toJSON() });
      if (error) throw error;
      updateNotificationButton(true);
    }
    await getPushPublicKey();
  } catch (error) {
    console.error('JVB notification setup failed:', error);
  } finally {
    button.disabled = false;
  }
}

async function disableNotifications() {
  if (!pushRegistration) return;
  const subscription = await pushRegistration.pushManager.getSubscription();
  if (subscription) {
    const endpoint = subscription.endpoint;
    if (!await subscription.unsubscribe()) throw new Error('Unable to unsubscribe');
    const { error } = await client.rpc('hope_jvb_unregister_push', { p_endpoint: endpoint });
    if (error) console.error('JVB notification cleanup failed:', error);
  }
  pushRegistration.active?.postMessage({ type: 'clear-unread' });
  updateNotificationButton(false);
}

async function toggleNotifications() {
  const button = document.getElementById('notificationToggle');
  showStatus('notificationStatus', '');
  if (!pushRegistration || !('Notification' in window)) {
    showStatus('notificationStatus', 'Add JVB to your Home Screen and open it there to enable notifications.');
    return;
  }
  button.disabled = true;
  try {
    if (button.getAttribute('aria-pressed') === 'true') {
      await disableNotifications();
      showStatus('notificationStatus', 'Notifications are off.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showStatus('notificationStatus', 'Notifications are not allowed in your device settings.');
      return;
    }
    const key = await getPushPublicKey();
    const subscription = await pushRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodePushKey(key) });
    const { error } = await client.rpc('hope_jvb_register_push', { p_subscription: subscription.toJSON() });
    if (error) {
      await subscription.unsubscribe();
      throw error;
    }
    updateNotificationButton(true);
    showStatus('notificationStatus', 'Notifications are on.');
  } catch (error) {
    console.error('JVB notification change failed:', error);
    showStatus('notificationStatus', 'Unable to change notifications. Please try again.');
  } finally {
    button.disabled = false;
  }
}

function markChatRead(channel, participantId) {
  pushRegistration?.active?.postMessage({ type: 'read-chat', channel, participantId });
}

function openNotificationChat(channel, participantId) {
  if (channel !== 'team' && channel !== 'direct') return;
  if (channel === 'direct' && account.is_coach && participantId) {
    const select = document.getElementById('conversationSelect');
    if (Array.from(select.options).some(option => option.value === participantId)) select.value = participantId;
  }
  setView(channel);
}

function updateChatRecipient() {
  const recipient = document.getElementById('chatRecipient');
  recipient.hidden = activeView !== 'direct';
  if (activeView === 'direct') {
    const player = roster.find(member => member.account_id === selectedParticipant());
    recipient.textContent = account.is_coach ? (player ? player.display_name : '') : 'Coach';
  }
}

function hideMessageMenu() {
  document.getElementById('messageMenu').hidden = true;
}

function showMessageMenu(message, x, y) {
  selectedMessage = message;
  const menu = document.getElementById('messageMenu');
  menu.hidden = false;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
  document.getElementById('editMessage').focus();
}

function addMessageActions(wrapper, meta, message) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'message-actions';
  button.setAttribute('aria-label', 'Message actions');
  button.title = 'Message actions';
  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-ellipsis';
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);
  meta.appendChild(button);
  button.addEventListener('click', () => {
    const bounds = button.getBoundingClientRect();
    showMessageMenu(message, bounds.left, bounds.bottom);
  });
  wrapper.addEventListener('contextmenu', event => {
    event.preventDefault();
    showMessageMenu(message, event.clientX, event.clientY);
  });
  let holdTimer;
  let startX;
  let startY;
  wrapper.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || event.target.closest('button')) return;
    startX = event.clientX;
    startY = event.clientY;
    holdTimer = window.setTimeout(() => showMessageMenu(message, startX, startY), 550);
  });
  wrapper.addEventListener('pointermove', event => {
    if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) window.clearTimeout(holdTimer);
  });
  wrapper.addEventListener('pointerup', () => window.clearTimeout(holdTimer));
  wrapper.addEventListener('pointercancel', () => window.clearTimeout(holdTimer));
}

async function saveMessageEdit(event) {
  event.preventDefault();
  const body = document.getElementById('editMessageInput').value.trim();
  if (!body) {
    showStatus('editMessageStatus', 'Enter a message.');
    return;
  }
  if (!selectedMessage) return;
  const button = document.getElementById('saveMessageEdit');
  button.disabled = true;
  showStatus('editMessageStatus', '');
  try {
    const { data, error } = await client.from('hope_jvb_messages').update({ body }).eq('id', selectedMessage.id).select('id');
    if (error) throw error;
    if (!data || !data.length) throw new Error('Message unavailable');
    document.getElementById('editMessageDialog').close();
    await renderMessages();
  } catch (error) {
    console.error('JVB message edit failed:', error);
    showStatus('editMessageStatus', 'Unable to edit this message. Please try again.');
  } finally {
    button.disabled = false;
  }
}

async function deleteSelectedMessage() {
  hideMessageMenu();
  if (!selectedMessage || !window.confirm('Delete this message?')) return;
  try {
    const { data, error } = await client.from('hope_jvb_messages').delete().eq('id', selectedMessage.id).select('id');
    if (error) throw error;
    if (!data || !data.length) throw new Error('Message unavailable');
    await renderMessages();
  } catch (error) {
    console.error('JVB message deletion failed:', error);
    showStatus('chatStatus', 'Unable to delete this message. Please try again.');
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
    markChatRead(channel, participant);
    const messages = (data || []).slice().reverse();
    const messagesKey = JSON.stringify([channel, participant, messages.map(message => [message.id, message.body])]);
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
      if (message.sender_id === account.account_id) addMessageActions(wrapper, meta, message);
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
  hideMessageMenu();
  activeView = view;
  document.body.classList.toggle('chat-active', view === 'team' || view === 'direct');
  requestVersion++;
  renderedMessagesKey = '';
  document.querySelectorAll('.tab').forEach(button => {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.getElementById('calendarView').hidden = view !== 'calendar';
  document.getElementById('chatView').hidden = view !== 'team' && view !== 'direct';
  document.getElementById('settingsView').hidden = view !== 'settings';
  if (view === 'calendar') {
    renderCalendar();
    return;
  }
  if (view === 'settings') return;
  document.getElementById('chatTitle').textContent = view === 'team' ? 'Team Chat' : 'Individual Chat';
  document.getElementById('conversationControl').hidden = view !== 'direct' || !account.is_coach;
  updateChatRecipient();
  document.getElementById('messages').replaceChildren();
  renderMessages();
}

function setSettingsPlatform(platform) {
  document.querySelectorAll('.settings-platform-option').forEach(button => {
    const selected = button.dataset.platform === platform;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.getElementById('iphoneDirections').hidden = platform !== 'iphone';
  document.getElementById('androidDirections').hidden = platform !== 'android';
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
  document.querySelectorAll('.settings-platform-option').forEach(button => button.addEventListener('click', () => setSettingsPlatform(button.dataset.platform)));
  document.getElementById('previousMonth').addEventListener('click', () => { if (monthIndex > 0) { monthIndex--; renderCalendar(); } });
  document.getElementById('nextMonth').addEventListener('click', () => { if (monthIndex < SCHEDULE_MONTHS.length - 1) { monthIndex++; renderCalendar(); } });
  document.getElementById('attendingButton').addEventListener('click', () => setAvailability(true));
  document.getElementById('notAttendingButton').addEventListener('click', () => setAvailability(false));
  document.getElementById('eventDialog').addEventListener('close', () => { availabilityVersion++; availabilityEventId = null; });
  document.getElementById('messageForm').addEventListener('submit', sendMessage);
  document.getElementById('notificationToggle').addEventListener('click', toggleNotifications);
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'open-chat') openNotificationChat(event.data.channel, event.data.participantId);
  });
  document.getElementById('editMessage').addEventListener('click', () => {
    hideMessageMenu();
    if (!selectedMessage) return;
    document.getElementById('editMessageInput').value = selectedMessage.body;
    showStatus('editMessageStatus', '');
    document.getElementById('editMessageDialog').showModal();
    document.getElementById('editMessageInput').focus();
  });
  document.getElementById('deleteMessage').addEventListener('click', deleteSelectedMessage);
  document.getElementById('editMessageForm').addEventListener('submit', saveMessageEdit);
  document.getElementById('cancelMessageEdit').addEventListener('click', () => document.getElementById('editMessageDialog').close());
  document.addEventListener('pointerdown', event => { if (!event.target.closest('#messageMenu')) hideMessageMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideMessageMenu(); });
  document.getElementById('messages').addEventListener('scroll', hideMessageMenu);
  document.getElementById('signOut').addEventListener('click', async () => {
    try { await disableNotifications(); } catch (error) {
      console.error('JVB notification sign-out cleanup failed:', error);
      showStatus('notificationStatus', 'Unable to turn off notifications. Please try signing out again.');
      return;
    }
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
  initializeNotifications();
  const notificationUrl = new URL(window.location.href);
  const notificationChat = notificationUrl.searchParams.get('chat');
  if (notificationChat === 'team' || notificationChat === 'direct') {
    openNotificationChat(notificationChat, notificationUrl.searchParams.get('participant'));
    notificationUrl.searchParams.delete('chat');
    notificationUrl.searchParams.delete('participant');
    window.history.replaceState(null, '', notificationUrl);
  }
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
