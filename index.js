// index.js
const { Telegraf, Markup } = require('telegraf');
const initFirebase = require('./firebase');
const cron = require('node-cron');
const geolib = require('geolib');

if (!process.env.BOT_TOKEN) {
  console.error("Missing BOT_TOKEN env var");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const admin = initFirebase();
const db = admin.database();

// util helpers
const usersRef = db.ref('users'); // user profiles
const likesRef = db.ref('likes'); // likes/from -> to true
const matchesRef = db.ref('matches'); // store matches
const swipesRef = db.ref('swipes'); // daily swipe counters
const paymentsRef = db.ref('payments');

// states for registration simple: saved in users/{id}/state
const STATES = {
  AWAIT_PHOTO: 'await_photo',
  AWAIT_NAME: 'await_name',
  AWAIT_DOB: 'await_dob',
  AWAIT_HEIGHT: 'await_height',
  AWAIT_GENDER: 'await_gender',
  AWAIT_LOOKING: 'await_looking',
  AWAIT_BIO: 'await_bio',
  AWAIT_LOCATION: 'await_location',
  ACTIVE: 'active'
};

function kbHome() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('▶️ Mulai Swipe','start_swipe')],
    [Markup.button.callback('🖼 Edit Profil','edit_profile'), Markup.button.callback('💎 Diamond','diamond')],
    [Markup.button.callback('👑 Upgrade Premium','upgrade'), Markup.button.callback('🚀 Boost Profil','boost')],
    [Markup.button.callback('👻 Ghost Mode','ghost'), Markup.button.callback('❤️ Match Saya','my_matches')]
  ]);
}

async function ensureUser(uid, tgUser) {
  const snap = await usersRef.child(uid).once('value');
  if (!snap.exists()) {
    const profile = {
      telegram_id: uid,
      username: tgUser.username || null,
      photos: [],
      state: STATES.AWAIT_PHOTO,
      created_at: Date.now(),
      diamond: 0,
      premium_until: 0,
      last_grant: 0,
      ghost_mode: false
    };
    await usersRef.child(uid).set(profile);
    return profile;
  }
  return snap.val();
}

bot.start(async (ctx) => {
  const uid = ctx.from.id.toString();
  const user = await ensureUser(uid, ctx.from);
  if (user.state !== STATES.ACTIVE) {
    await ctx.replyWithMarkdown(
      `Halo *${ctx.from.first_name}*! Selamat datang di Cari Teman Sekitar.\n\nKamu harus isi profil dulu agar bisa cari teman.\nSilakan kirim 1 foto profil (wajib).`,
      Markup.inlineKeyboard([[Markup.button.callback('Batal Registrasi','cancel_reg')]])
    );
    await usersRef.child(uid).update({state: STATES.AWAIT_PHOTO});
  } else {
    // show home
    const age = user.age || '?';
    const pd = `Nama: ${user.display_name || ctx.from.first_name}\nUsia: ${age}\nDiamond: ${user.diamond||0}\nPremium: ${user.premium_until > Date.now() ? 'Ya' : 'Tidak'}`;
    await ctx.reply(pd, kbHome());
  }
});

// cancel reg
bot.action('cancel_reg', async (ctx) => {
  const uid = ctx.from.id.toString();
  await usersRef.child(uid).remove();
  await ctx.editMessageText('Registrasi dibatalkan. Ketik /start untuk mulai lagi.');
});

// Photo handler (profile)
bot.on('photo', async (ctx) => {
  const uid = ctx.from.id.toString();
  const snap = await usersRef.child(uid).once('value');
  if (!snap.exists()) {
    await ctx.reply('Ketik /start untuk mulai registrasi.');
    return;
  }
  const user = snap.val();
  if (user.state !== STATES.AWAIT_PHOTO) {
    // ignore or allow updating photo via edit profile later
    await ctx.reply('Jika ingin mengganti foto, gunakan Edit Profil > Ganti Foto.');
    return;
  }
  // get highest res photo file_id
  const file = ctx.message.photo.pop();
  const photos = user.photos || [];
  photos.push(file.file_id);
  await usersRef.child(uid).update({photos, state: STATES.AWAIT_NAME});
  await ctx.reply('Foto tersimpan. Sekarang kirim Nama tampil (contoh: Budi).');
});

// text handler for stages
bot.on('text', async (ctx) => {
  const uid = ctx.from.id.toString();
  const snap = await usersRef.child(uid).once('value');
  if (!snap.exists()) {
    ctx.reply('Ketik /start untuk membuat profil.');
    return;
  }
  const user = snap.val();
  const txt = ctx.message.text.trim();

  switch (user.state) {
    case STATES.AWAIT_NAME:
      await usersRef.child(uid).update({display_name: txt, state: STATES.AWAIT_DOB});
      await ctx.reply('Masukkan tanggal lahir format DD-MM-YYYY (contoh: 17-08-2000).');
      break;

    case STATES.AWAIT_DOB:
      // basic parse
      const parts = txt.split('-');
      if (parts.length !== 3) { return ctx.reply('Format salah. Contoh: 17-08-2000'); }
      const d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      if (isNaN(d.getTime())) return ctx.reply('Tanggal tidak valid.');
      const age = new Date().getFullYear() - d.getFullYear();
      if (age < 18) return ctx.reply('Umur harus 18+ untuk menggunakan bot.');
      await usersRef.child(uid).update({birth_date: txt, age, state: STATES.AWAIT_HEIGHT});
      await ctx.reply('Masukkan tinggi badan (cm), misal: 170');
      break;

    case STATES.AWAIT_HEIGHT:
      const h = parseInt(txt);
      if (!h || h < 120 || h > 240) return ctx.reply('Tinggi tidak valid. Contoh: 170');
      await usersRef.child(uid).update({height: h, state: STATES.AWAIT_GENDER});
      await ctx.reply('Pilih jenis kelamin:', Markup.inlineKeyboard([
        [Markup.button.callback('Laki-laki','gender_m'), Markup.button.callback('Perempuan','gender_f')]
      ]));
      break;

    case STATES.AWAIT_BIO:
      await usersRef.child(uid).update({bio: txt, state: STATES.AWAIT_LOCATION});
      await ctx.reply('Terakhir, silakan kirim lokasi kamu (gunakan fitur Share Location Telegram).');
      break;

    // allow quick commands in active state
    default:
      if (txt === '/home') {
        const u = (await usersRef.child(uid).once('value')).val();
        return ctx.reply(`${u.display_name}\nUsia ${u.age}\nDiamond: ${u.diamond||0}`, kbHome());
      }
      ctx.reply('Perintah tidak dikenali. Gunakan tombol di bawah atau ketik /start.');
  }
});

// gender button
bot.action('gender_m', async (ctx) => {
  const uid = ctx.from.id.toString();
  await usersRef.child(uid).update({gender: 'M', state: STATES.AWAIT_LOOKING});
  await ctx.editMessageText('Kamu pilih Laki-laki. Siapa yang kamu cari?', Markup.inlineKeyboard([
    [Markup.button.callback('Laki-laki','look_m'), Markup.button.callback('Perempuan','look_f'), Markup.button.callback('Bebas','look_any')]
  ]));
});
bot.action('gender_f', async (ctx) => {
  const uid = ctx.from.id.toString();
  await usersRef.child(uid).update({gender: 'F', state: STATES.AWAIT_LOOKING});
  await ctx.editMessageText('Kamu pilih Perempuan. Siapa yang kamu cari?', Markup.inlineKeyboard([
    [Markup.button.callback('Laki-laki','look_m'), Markup.button.callback('Perempuan','look_f'), Markup.button.callback('Bebas','look_any')]
  ]));
});
bot.action('look_m', async (ctx) => {
  const uid = ctx.from.id.toString();
  await usersRef.child(uid).update({looking_for: 'M', state: STATES.AWAIT_BIO});
  await ctx.editMessageText('Tulis bio singkat (max 150 karakter).');
});
bot.action('look_f', async (ctx) => {
  const uid = ctx.from.id.toString();
  await usersRef.child(uid).update({looking_for: 'F', state: STATES.AWAIT_BIO});
  await ctx.editMessageText('Tulis bio singkat (max 150 karakter).');
});
bot.action('look_any', async (ctx) => {
  const uid = ctx.from.id.toString();
  await usersRef.child(uid).update({looking_for: 'A', state: STATES.AWAIT_BIO});
  await ctx.editMessageText('Tulis bio singkat (max 150 karakter).');
});

// location handler
bot.on('location', async (ctx) => {
  const uid = ctx.from.id.toString();
  const userSnap = await usersRef.child(uid).once('value');
  if (!userSnap.exists()) return ctx.reply('Mulai registrasi dulu dengan /start');
  const user = userSnap.val();
  if (user.state !== STATES.AWAIT_LOCATION && user.state !== STATES.ACTIVE) {
    // accept location during registration or update
  }
  const { latitude, longitude } = ctx.message.location;
  await usersRef.child(uid).update({lat: latitude, lon: longitude, location_enabled: true, state: STATES.ACTIVE});
  await ctx.reply('Lokasi disimpan. Profil aktif!', kbHome());
});

// HOME actions
bot.action('start_swipe', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id.toString();
  // present next candidate
  await sendNextCandidate(ctx, uid);
});

bot.action('edit_profile', async (ctx) => {
  const uid = ctx.from.id.toString();
  await ctx.answerCbQuery();
  await ctx.reply('Menu Edit Profil:\n– Kirim foto baru untuk ganti foto utama\n– Ketik /change_name untuk ganti nama\n– Ketik /change_bio untuk ganti bio\nKetik /home untuk kembali', kbHome());
});

bot.action('diamond', async (ctx) => {
  const uid = ctx.from.id.toString();
  const u = (await usersRef.child(uid).once('value')).val();
  await ctx.answerCbQuery();
  await ctx.reply(`Saldo Diamond: ${u.diamond||0}\nPaket:\n5 = Rp10.000\n15 = Rp25.000\n50 = Rp60.000\n\nUntuk sekarang, pembayaran manual via transfer.`, kbHome());
});

bot.action('upgrade', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Upgrade Premium: (belum terintegrasi). Nanti akan saya bantu pasang Midtrans.', kbHome());
});
bot.action('boost', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Boost: fitur berbayar. Saat aktivasi premium, kamu dapat boost 3 jam gratis.', kbHome());
});
bot.action('ghost', async (ctx) => {
  const uid = ctx.from.id.toString();
  const uSnap = (await usersRef.child(uid).once('value')).val();
  if (!(uSnap && uSnap.premium_until && uSnap.premium_until > Date.now())) {
    return ctx.answerCbQuery('Ghost mode hanya untuk premium.');
  }
  const newVal = !uSnap.ghost_mode;
  await usersRef.child(uid).update({ghost_mode: newVal});
  await ctx.answerCbQuery(`Ghost mode ${newVal ? 'ON' : 'OFF'}`);
  await ctx.editMessageReplyMarkup(kbHome().reply_markup);
});
bot.action('my_matches', async (ctx) => {
  const uid = ctx.from.id.toString();
  const ms = (await matchesRef.orderByChild('users').once('value')).val() || {};
  const list = [];
  for (let k in ms) {
    const m = ms[k];
    if (m.userA == uid || m.userB == uid) {
      const other = m.userA == uid ? m.userB : m.userA;
      const u = (await usersRef.child(other).once('value')).val();
      list.push(`@${u.username||'(no username)'} — ${u.display_name}`);
    }
  }
  await ctx.answerCbQuery();
  await ctx.reply(list.length ? list.join('\n') : 'Belum ada match', kbHome());
});

// helper: send next candidate based on distance & skips
async function sendNextCandidate(ctx, uid) {
  const me = (await usersRef.child(uid).once('value')).val();
  if (!me || !me.location_enabled) return ctx.reply('Aktifkan lokasi dulu di profil (share location).');

  // limit swipe daily
  const today = new Date().toISOString().slice(0,10);
  const sSnap = (await swipesRef.child(uid).child(today).once('value')).val() || {count:0};
  const limit = (me.premium_until && me.premium_until > Date.now()) ? 9999 : 20;
  if (sSnap.count >= limit) {
    return ctx.reply('Swipe harian habis. Upgrade premium untuk unlimited.', kbHome());
  }

  // query all users, filter by looking_for & not skipped & not self & ghost mode off
  const allSnap = (await usersRef.once('value')).val() || {};
  const candidates = [];
  for (let k in allSnap) {
    if (k === uid) continue;
    const u = allSnap[k];
    if (!u.location_enabled) continue;
    if (u.ghost_mode) continue;
    // check preference
    if (me.looking_for && me.looking_for !== 'A' && me.looking_for !== u.gender) continue;
    // check already skipped/liked
    const skip = (await likesRef.child(uid).child(k).once('value')).val();
    if (skip && (skip === 'skip' || skip === 'like')) continue;
    // compute distance
    const dist = geolib.getDistance({latitude: me.lat, longitude: me.lon}, {latitude: u.lat, longitude: u.lon});
    candidates.push({id:k, dist, profile:u});
  }

  if (candidates.length === 0) return ctx.reply('Tidak ada kandidat di radius setempat. Coba perbesar area atau tunggu pengguna lain.', kbHome());

  // sort by distance asc
  candidates.sort((a,b) => a.dist - b.dist);
  const cand = candidates[0];

  // prepare photos as media group if exists
  const photos = cand.profile.photos || [];
  // send first photo then caption with data & inline buttons
  const km = (cand.dist/1000).toFixed(1);
  const caption = `*${cand.profile.display_name}*, ${cand.profile.age} — ${km} km\n${cand.profile.bio || ''}`;
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('❤️ Like', `like_${cand.id}`), Markup.button.callback('❌ Skip', `skip_${cand.id}`)],
    [Markup.button.callback('💎 Kirim Diamond', `diamond_${cand.id}`)],
    [Markup.button.callback('🏠 HOME','goto_home')]
  ]);
  if (photos.length) {
    // send first photo with caption
    await ctx.replyWithPhoto(photos[0], {caption, parse_mode:'Markdown', ...buttons});
  } else {
    await ctx.reply(caption, buttons);
  }

  // store current presenting candidate to allow next actions to detect
  await usersRef.child(uid).child('presenting').set(cand.id);
}

// home action goto_home
bot.action('goto_home', async (ctx) => {
  const uid = ctx.from.id.toString();
  const u = (await usersRef.child(uid).once('value')).val();
  await ctx.editMessageText(`${u.display_name}\nUsia: ${u.age}\nDiamond: ${u.diamond||0}`, kbHome());
});

// like/skip/diamond handlers generic
bot.action(/like_(.+)/, async (ctx) => {
  const uid = ctx.from.id.toString();
  const to = ctx.match[1];
  await likesRef.child(uid).child(to).set('like');
  // increase swipe count
  await incrementSwipe(uid);
  // check mutual
  const otherLike = (await likesRef.child(to).child(uid).once('value')).val();
  if (otherLike === 'like') {
    // create match
    const mKey = matchesRef.push().key;
    await matchesRef.child(mKey).set({userA: uid, userB: to, created_at: Date.now()});
    // send username to both
    const uTo = (await usersRef.child(to).once('value')).val();
    const uFrom = (await usersRef.child(uid).once('value')).val();
    try {
      if (uTo.username) await bot.telegram.sendMessage(uid, `🎉 MATCH! Username: @${uTo.username}`);
      else await bot.telegram.sendMessage(uid, `🎉 MATCH! Namun target belum punya username. Minta dia set username.`);
      if (uFrom.username) await bot.telegram.sendMessage(to, `🎉 MATCH! Username: @${uFrom.username}`);
      else await bot.telegram.sendMessage(to, `🎉 MATCH! Namun target belum punya username.`);
    } catch (err) { console.error(err); }
  } else {
    await ctx.reply('Disimpan. Semoga dia like balik!');
  }
  await ctx.answerCbQuery();
  // send next candidate
  await sendNextCandidate(ctx, uid);
});

bot.action(/skip_(.+)/, async (ctx) => {
  const uid = ctx.from.id.toString();
  const to = ctx.match[1];
  await likesRef.child(uid).child(to).set('skip');
  await incrementSwipe(uid);
  await ctx.answerCbQuery();
  await sendNextCandidate(ctx, uid);
});

bot.action(/diamond_(.+)/, async (ctx) => {
  const uid = ctx.from.id.toString();
  const to = ctx.match[1];
  const u = (await usersRef.child(uid).once('value')).val();
  if ((u.diamond||0) <= 0) {
    await ctx.answerCbQuery('Diamond tidak cukup.');
    return ctx.reply('Diamond kamu kosong. Tunggu free claim atau beli.');
  }
  // consume 1 diamond and reveal target username
  await usersRef.child(uid).update({diamond: (u.diamond||0) - 1});
  const target = (await usersRef.child(to).once('value')).val();
  if (target.username) {
    await ctx.reply(`Username target: @${target.username}`);
  } else {
    await ctx.reply(`Target belum punya username. Minta dia atur username Telegram.`);
  }
  await ctx.answerCbQuery();
});

// helper increment swipe
async function incrementSwipe(uid) {
  const today = new Date().toISOString().slice(0,10);
  const sRef = swipesRef.child(uid).child(today);
  const snap = (await sRef.once('value')).val() || {count:0};
  await sRef.set({count: (snap.count||0)+1});
}

// background cron for diamond grants
// run once per hour to keep lightweight; logic grants free diamond if last_grant > 3 days
cron.schedule('0 * * * *', async () => {
  try {
    const all = (await usersRef.once('value')).val() || {};
    const now = Date.now();
    for (let uid in all) {
      const u = all[uid];
      // free user: 1 diamond per 3 days
      if (!u.premium_until || u.premium_until < now) {
        const last = u.last_grant || 0;
        if (now - last > 3*24*3600*1000) {
          await usersRef.child(uid).update({diamond: (u.diamond||0)+1, last_grant: now});
        }
      } else {
        // premium: 3 diamond per day if not yet granted today
        const last = u.last_grant || 0;
        if ((new Date(last)).toDateString() !== new Date(now).toDateString()) {
          await usersRef.child(uid).update({diamond: (u.diamond||0)+3, last_grant: now});
        }
      }
    }
  } catch (e) { console.error('cron err', e); }
});

bot.launch().then(()=> console.log('Bot started'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));