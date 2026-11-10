(() => {
  const PROJECT_URL = 'https://ffkqgkxxykoxztvigxzd.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_StmzzSlgrhDeLbL5_lPfIw_5lYdzXpG';
  const TABLE = 'calendar_events';
  const frame = document.getElementById('calendarFrame');
  const status = document.getElementById('syncStatus');

  const db = window.supabase.createClient(PROJECT_URL, PUBLISHABLE_KEY);
  window.hopeSupabase = db;

  function showStatus(message, isError = false) {
    status.textContent = message;
    status.classList.remove('hidden', 'bg-emerald-700', 'bg-rose-700');
    status.classList.add(isError ? 'bg-rose-700' : 'bg-emerald-700');
    if (!isError) {
      window.clearTimeout(showStatus.timer);
      showStatus.timer = window.setTimeout(() => status.classList.add('hidden'), 3000);
    }
  }

  function installCalendarBridge() {
    const child = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!child || !doc || !doc.getElementById('calendarGrid') || child.__hopeBridgeInstalled) return;

    child.__hopeBridgeInstalled = true;
    const script = doc.createElement('script');
    script.textContent = `
      (() => {
        const calendarDb = parent.hopeSupabase;
        const calendarTable = 'calendar_events';
        let refreshInProgress = false;

        function presentError(message) {
          parent.document.getElementById('syncStatus').textContent = message;
          const status = parent.document.getElementById('syncStatus');
          status.classList.remove('hidden', 'bg-emerald-700');
          status.classList.add('bg-rose-700');
        }

        async function fetchSharedEvents() {
          const { data, error } = await calendarDb
            .from(calendarTable)
            .select('id,date,title,time,category,location,details')
            .order('date', { ascending: true });

          if (error) throw error;

          if (data.length === 0) {
            const { error: seedError } = await calendarDb
              .from(calendarTable)
              .insert(defaultEventsData);
            if (seedError && seedError.code !== '23505') throw seedError;
            const { data: seeded, error: readError } = await calendarDb
              .from(calendarTable)
              .select('id,date,title,time,category,location,details')
              .order('date', { ascending: true });
            if (readError) throw readError;
            eventsData = seeded || [];
          } else {
            eventsData = data;
          }

          renderCalendarGrid();
          parent.document.getElementById('syncStatus').textContent = 'Schedule synced';
          parent.document.getElementById('syncStatus').classList.remove('hidden', 'bg-rose-700');
          parent.document.getElementById('syncStatus').classList.add('bg-emerald-700');
          parent.setTimeout(() => parent.document.getElementById('syncStatus').classList.add('hidden'), 2200);
        }

        async function refreshFromRealtime() {
          if (refreshInProgress) return;
          refreshInProgress = true;
          try {
            const { data, error } = await calendarDb
              .from(calendarTable)
              .select('id,date,title,time,category,location,details')
              .order('date', { ascending: true });
            if (error) throw error;
            eventsData = data || [];
            renderCalendarGrid();
          } catch (error) {
            presentError('Could not receive live schedule updates.');
            console.error('Supabase realtime refresh failed:', error);
          } finally {
            refreshInProgress = false;
          }
        }

        async function saveEditedEvent(event) {
          event.preventDefault();
          const id = document.getElementById('editEventId').value;
          const updated = {
            title: document.getElementById('editEventTitle').value.trim(),
            category: document.getElementById('editEventCategory').value,
            date: document.getElementById('editEventDate').value,
            time: document.getElementById('editEventTime').value.trim(),
            location: document.getElementById('editEventLocation').value.trim(),
            details: document.getElementById('editEventDetails').value.trim()
          };
          const { error } = await calendarDb.from(calendarTable).update(updated).eq('id', id);
          if (error) {
            presentError('Save failed. Check Supabase permissions and table columns.');
            console.error('Supabase event update failed:', error);
            return;
          }
          Object.assign(eventsData.find(item => item.id === id) || {}, updated);
          renderCalendarGrid();
          closeModal();
          parent.document.getElementById('syncStatus').textContent = 'Change saved for everyone';
          parent.document.getElementById('syncStatus').classList.remove('hidden', 'bg-rose-700');
          parent.document.getElementById('syncStatus').classList.add('bg-emerald-700');
          parent.setTimeout(() => parent.document.getElementById('syncStatus').classList.add('hidden'), 2500);
        }

        async function deleteCurrentEvent() {
          const id = document.getElementById('editEventId').value;
          if (!confirm('Are you sure you want to delete this event for everyone?')) return;
          const { error } = await calendarDb.from(calendarTable).delete().eq('id', id);
          if (error) {
            presentError('Delete failed. Check Supabase permissions.');
            console.error('Supabase event delete failed:', error);
            return;
          }
          eventsData = eventsData.filter(item => item.id !== id);
          renderCalendarGrid();
          closeModal();
        }

        async function addNewEvent(event) {
          event.preventDefault();
          const title = document.getElementById('newEventTitle').value.trim();
          const category = document.getElementById('newEventCategory').value;
          const date = document.getElementById('newEventDate').value;
          const time = document.getElementById('newEventTime').value.trim();
          const location = document.getElementById('newEventLocation').value.trim() || 'Hope School Gym';
          if (!title || !date || !time) return;

          const newEvent = {
            id: 'custom-' + crypto.randomUUID(),
            date,
            title,
            time,
            category,
            location,
            details: 'User added custom event.'
          };
          const { error } = await calendarDb.from(calendarTable).insert(newEvent);
          if (error) {
            presentError('Add failed. Check Supabase permissions and table columns.');
            console.error('Supabase event insert failed:', error);
            return;
          }
          eventsData.push(newEvent);
          renderCalendarGrid();
          document.getElementById('addEventForm').reset();
          closeAddModal();
        }

        async function resetSchedule() {
          if (!confirm('Reset the shared schedule to the original defaults for everyone? This replaces all current events.')) return;
          const { error: deleteError } = await calendarDb.from(calendarTable).delete().not('id', 'is', null);
          if (deleteError) {
            presentError('Reset failed. Check Supabase delete permissions.');
            console.error('Supabase schedule reset failed:', deleteError);
            return;
          }
          const { error: insertError } = await calendarDb.from(calendarTable).insert(defaultEventsData);
          if (insertError) {
            presentError('Defaults were removed but could not be restored. Check Supabase insert permissions.');
            console.error('Supabase schedule reset insert failed:', insertError);
            return;
          }
          await fetchSharedEvents();
        }

        window.handleSaveEditedEvent = saveEditedEvent;
        window.handleDeleteCurrentEvent = deleteCurrentEvent;
        window.handleAddNewEvent = addNewEvent;
        window.resetToDefaultEvents = resetSchedule;

        fetchSharedEvents().catch(error => {
          presentError('Could not load shared calendar. Check Supabase table, policies, and key.');
          console.error('Supabase calendar load failed:', error);
        });

        calendarDb.channel('hope-calendar-live')
          .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: calendarTable
          }, refreshFromRealtime)
          .subscribe((state) => {
            if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
              presentError('Live updates could not connect.');
            }
          });
      })();
    `;
    doc.body.appendChild(script);
  }

  frame.addEventListener('load', installCalendarBridge);
  const waitForFrame = window.setInterval(() => {
    if (frame.contentDocument && frame.contentDocument.readyState === 'complete') {
      installCalendarBridge();
      if (frame.contentWindow && frame.contentWindow.__hopeBridgeInstalled) {
        window.clearInterval(waitForFrame);
      }
    }
  }, 250);
})();
