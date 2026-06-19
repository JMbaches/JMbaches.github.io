// migrate-dossier-ids.js — Renomme les dossiers D-20XX-XXX vers leur ref Mégao
// Usage : node scripts/migrate-dossier-ids.js /chemin/vers/service-account.json

const admin = require('firebase-admin');
const fs    = require('fs');

const keyPath = process.argv[2];
if (!keyPath) { console.error('Usage : node migrate-dossier-ids.js <service-account.json>'); process.exit(1); }

admin.initializeApp({
  credential:    admin.credential.cert(JSON.parse(fs.readFileSync(keyPath, 'utf8'))),
  storageBucket: 'jm-baches.firebasestorage.app',
});
const db = admin.firestore();

function refToId(ref) {
  return (ref || '').replace(/\//g, '-').replace(/\s+/g, '_').trim();
}

async function migrate() {
  const snap = await db.collection('dossiers').get();
  let migrated = 0, skipped = 0, conflicts = 0;

  for (const doc of snap.docs) {
    const data  = doc.data();
    const oldId = doc.id;

    // Ne migrer que les dossiers au format D-20XX-XXX
    if (!/^D-\d{4}-\d+$/.test(oldId)) { skipped++; continue; }

    if (!data.ref) {
      console.log(`⚠️  ${oldId} — pas de ref Mégao, ignoré`);
      skipped++;
      continue;
    }

    const newId = refToId(data.ref);
    if (!newId || newId === oldId) { skipped++; continue; }

    // Vérifier que le nouvel ID n'existe pas déjà
    const target = await db.collection('dossiers').doc(newId).get();
    if (target.exists) {
      console.log(`⚠️  ${oldId} → ${newId} déjà existant — ignoré`);
      conflicts++;
      continue;
    }

    await db.collection('dossiers').doc(newId).set(data);
    await doc.ref.delete();
    console.log(`✓  ${oldId} → ${newId}  (ref: ${data.ref}, client: ${data.client || '—'})`);
    migrated++;
  }

  console.log(`\nTerminé : ${migrated} migrés · ${skipped} ignorés · ${conflicts} conflits`);
  if (conflicts > 0) console.log('Les conflits sont des dossiers dont la ref existait déjà comme ID — vérifier manuellement.');
}

migrate().catch(e => { console.error('Erreur :', e); process.exit(1); });
