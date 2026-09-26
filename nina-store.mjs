export const MIGRATION = `
CREATE TABLE IF NOT EXISTS nina_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO nina_schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS nina_model_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS nina_shadow_signals (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  symbol text NOT NULL,
  side text NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  record jsonb NOT NULL,
  model_version text NOT NULL DEFAULT '0.7-shadow'
);
CREATE INDEX IF NOT EXISTS nina_shadow_closed_at ON nina_shadow_signals(closed_at DESC) WHERE status='CLOSED';
CREATE TABLE IF NOT EXISTS nina_learner_weights (
  version text PRIMARY KEY,
  mode text NOT NULL CHECK (mode='CHALLENGER_SHADOW'),
  weights jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export function createStore(pool) {
  return {
    async migrate(){await pool.query(MIGRATION);},
    async importLegacy(snapshot){
      const client=await pool.connect();
      try{await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(12101)");
        const done=await client.query("SELECT key FROM nina_model_state WHERE key='legacy_import'");
        if(!done.rows.length){
          const rows=[...(snapshot.shadow?.active||[]),...(snapshot.shadow?.closed||[])];
          for(const r of rows){if(!r.id||!Number.isFinite(r.opened))continue;
            await client.query("INSERT INTO nina_shadow_signals(id,status,symbol,side,opened_at,closed_at,record) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0),to_timestamp($6/1000.0),$7::jsonb) ON CONFLICT(id) DO NOTHING",[r.id,r.closed?'CLOSED':'OPEN',r.symbol,r.side,r.opened,r.closed??null,JSON.stringify({...r,legacy:true,methodology:'legacy-v0.7-unvalidated'})]);
          }
          if(snapshot.report?.challengerWeights)await client.query("INSERT INTO nina_learner_weights(version,mode,weights) VALUES('0.7-shadow','CHALLENGER_SHADOW',$1::jsonb) ON CONFLICT(version) DO NOTHING",[JSON.stringify(snapshot.report.challengerWeights)]);
          await client.query("INSERT INTO nina_model_state(key,value) VALUES('legacy_import',$1::jsonb) ON CONFLICT DO NOTHING",[JSON.stringify({capturedAt:snapshot.report?.at??null,count:rows.length})]);
        }
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    },
    async saveState(key,value){await pool.query("INSERT INTO nina_model_state(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[key,JSON.stringify(value)]);},
    async state(key){return (await pool.query('SELECT value FROM nina_model_state WHERE key=$1',[key])).rows[0]?.value??null;},
    async saveWeights(weights){await pool.query("INSERT INTO nina_learner_weights(version,mode,weights) VALUES('0.7-shadow','CHALLENGER_SHADOW',$1::jsonb) ON CONFLICT(version) DO NOTHING",[JSON.stringify(weights)]);},
    async history(){return (await pool.query('SELECT record FROM nina_shadow_signals ORDER BY opened_at DESC LIMIT 1000')).rows.map(x=>x.record);},
    async summary(){return (await pool.query("SELECT count(*)::int AS signals,count(*) FILTER(WHERE status='OPEN')::int AS open,count(*) FILTER(WHERE status='CLOSED')::int AS outcomes,md5(COALESCE(string_agg(id,',' ORDER BY id),'')) AS history_digest FROM nina_shadow_signals")).rows[0];},
    async load(){
      const [open,closed,weights]=await Promise.all([
        pool.query("SELECT record FROM nina_shadow_signals WHERE status='OPEN' ORDER BY opened_at"),
        pool.query("SELECT record FROM nina_shadow_signals WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 1000"),
        pool.query("SELECT weights FROM nina_learner_weights WHERE version='0.7-shadow' AND mode='CHALLENGER_SHADOW'")
      ]);
      return {open:open.rows.map(x=>x.record),closed:closed.rows.map(x=>x.record).reverse(),weights:weights.rows[0]?.weights||null};
    },
    async recordOpen(sig){
      const r=await pool.query(`INSERT INTO nina_shadow_signals(id,status,symbol,side,opened_at,record)
        VALUES($1,'OPEN',$2,$3,to_timestamp($4/1000.0),$5::jsonb) ON CONFLICT(id) DO NOTHING`,
        [sig.id,sig.symbol,sig.side,sig.opened,JSON.stringify(sig)]);
      return r.rowCount===1;
    },
    async recordProgress(sig){
      await pool.query("UPDATE nina_shadow_signals SET record=$2::jsonb WHERE id=$1 AND status='OPEN'",[sig.id,JSON.stringify(sig)]);
    },
    async recordClose(rec, weights){
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const r=await client.query(`UPDATE nina_shadow_signals SET status='CLOSED',closed_at=to_timestamp($2/1000.0),record=$3::jsonb
          WHERE id=$1 AND status='OPEN'`,[rec.id,rec.closed,JSON.stringify(rec)]);
        if(r.rowCount!==1){await client.query('ROLLBACK');return false;}
        await client.query(`INSERT INTO nina_learner_weights(version,mode,weights,updated_at)
          VALUES('0.7-shadow','CHALLENGER_SHADOW',$1::jsonb,now())
          ON CONFLICT(version) DO UPDATE SET weights=EXCLUDED.weights,updated_at=now()`,[JSON.stringify(weights)]);
        await client.query('COMMIT');return true;
      }catch(e){await client.query('ROLLBACK');throw e;}
      finally{client.release();}
    }
  };
}
