import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openSync,closeSync,writeFileSync,readFileSync,unlinkSync } from 'node:fs';
export class Store {
  readonly db: DatabaseSync;
  private lockPath:string;
  constructor(dataDir: string) {
    this.lockPath=join(dataDir,'instance.lock');
    const claim=()=>{const fd=openSync(this.lockPath,'wx',0o600);try{writeFileSync(fd,JSON.stringify({pid:process.pid}));}finally{closeSync(fd);}};
    try{claim();}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;let alive=true;try{const previous=JSON.parse(readFileSync(this.lockPath,'utf8'));if(!Number.isInteger(previous.pid)||previous.pid<1)throw new Error('实例锁格式异常，请检查本地状态');try{process.kill(previous.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw e;}}catch{throw new Error('无法核对本地实例锁；请先关闭已有服务或检查运行状态');}if(alive)throw new Error('当前数据目录已有 Bridge 实例运行');unlinkSync(this.lockPath);claim();}
    this.db=new DatabaseSync(join(dataDir,'bridge.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,task_id TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,call_id TEXT,message TEXT,authorized INTEGER NOT NULL DEFAULT 0,request TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,notification_id TEXT NOT NULL,recipient TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,task_id TEXT NOT NULL,thread_id TEXT,session_id TEXT,status TEXT NOT NULL,question TEXT NOT NULL,options TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,option_id TEXT,responded_at INTEGER);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS task_monitors(task_id TEXT PRIMARY KEY,source TEXT NOT NULL,thread_id TEXT,session_id TEXT,last_seen INTEGER NOT NULL,active INTEGER NOT NULL,notified INTEGER NOT NULL DEFAULT 0)');
    // An in-flight request might already have dialled; never retry after a crash.
    this.db.prepare("UPDATE notifications SET status='unknown',message='程序在通话处理中重启；需人工核对，未自动重拨',updated_at=? WHERE status IN ('dialing','accepted')").run(Date.now());
  }
  all(sql: string,...params:any[]) { return this.db.prepare(sql).all(...params) as any[]; }
  get(sql:string,...params:any[]) {return this.db.prepare(sql).get(...params) as any;}
  run(sql:string,...params:any[]) {return this.db.prepare(sql).run(...params);}
  meta(key:string,fallback:string) {return this.get('SELECT value FROM meta WHERE key=?',key)?.value ?? fallback;}
  setMeta(key:string,value:string) {this.run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,value);}
  transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try {const out=fn();this.db.exec('COMMIT');return out;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  close(){this.db.close();try{const lock=JSON.parse(readFileSync(this.lockPath,'utf8'));if(lock.pid===process.pid)unlinkSync(this.lockPath);}catch{}}
}
