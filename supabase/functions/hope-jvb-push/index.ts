import { createClient } from 'npm:@supabase/supabase-js@2';
import webPush from 'npm:web-push@3.6.7';

const projectUrl = Deno.env.get('SUPABASE_URL')!;
const publicKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false } });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function getKeys() {
  const generated = webPush.generateVAPIDKeys();
  const { data, error } = await admin.rpc('hope_jvb_push_get_keys', {
    p_public: generated.publicKey,
    p_private: generated.privateKey,
  });
  if (error || !data?.[0]) throw new Error('Push keys unavailable');
  return data[0] as { public_key: string; private_key: string };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  try {
    const body = await request.json();
    if (body.action === 'public-key') {
      const authorization = request.headers.get('Authorization');
      if (!authorization) return reply({ error: 'Sign-in required' }, 401);
      const caller = createClient(projectUrl, publicKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false },
      });
      const { data: user, error: userError } = await caller.auth.getUser();
      const { data: session, error: sessionError } = await caller.rpc('hope_jvb_session');
      if (userError || !user.user || sessionError || !session?.length) return reply({ error: 'JVB sign-in required' }, 403);
      const keys = await getKeys();
      return reply({ publicKey: keys.public_key });
    }
    if (body.action !== 'deliver' || typeof body.token !== 'string' || typeof body.message_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.message_id)) {
      return reply({ error: 'Invalid request' }, 400);
    }
    const { data: authorized, error: authError } = await admin.rpc('hope_jvb_push_authorize', { p_token: body.token });
    if (authError || !authorized) return reply({ error: 'Not authorized' }, 403);
    const { data: targets, error: targetError } = await admin.rpc('hope_jvb_push_targets', { p_message_id: body.message_id });
    if (targetError) throw targetError;
    if (!targets?.length) return reply({ delivered: 0 });
    const keys = await getKeys();
    webPush.setVapidDetails('https://dmac555.github.io/hope2026bballschedule/', keys.public_key, keys.private_key);
    let delivered = 0;
    await Promise.all(targets.map(async (target: { endpoint: string; subscription: webPush.PushSubscription; channel: string; participant_id: string | null }) => {
      try {
        await webPush.sendNotification(target.subscription, JSON.stringify({
          channel: target.channel,
          participantId: target.participant_id,
        }), { TTL: 86400 });
        delivered++;
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await admin.rpc('hope_jvb_push_remove_expired', { p_endpoint: target.endpoint });
        } else {
          console.error('JVB push delivery failed', statusCode || 'unknown');
        }
      }
    }));
    return reply({ delivered });
  } catch (_error) {
    console.error('JVB push request failed');
    return reply({ error: 'Unable to process notification request' }, 500);
  }
});