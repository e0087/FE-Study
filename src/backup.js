import {all,openDB,settings} from './db.js';

export const BACKUP_FORMAT_VERSION=1;
export const DATA_STORES=['attempts','reviews','bookmarks','sessions','userQuestions'];
const SETTING_KEYS=['theme','dailyGoal','reviewIntervals','questionCount','showSubjectA','showSubjectB'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const date=value=>typeof value==='string'&&!Number.isNaN(Date.parse(value));

export async function createBackup(){
  const db=await openDB();
  const rows=await new Promise((resolve,reject)=>{
    const tx=db.transaction(DATA_STORES,'readonly'),result={};
    for(const name of DATA_STORES){const request=tx.objectStore(name).getAll();request.onsuccess=()=>{result[name]=request.result};request.onerror=()=>reject(request.error);}
    tx.oncomplete=()=>resolve(DATA_STORES.map(name=>result[name]));tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('バックアップの読み込みを取り消しました。'));
  });
  const data=Object.fromEntries(DATA_STORES.map((name,i)=>[name,rows[i]]));
  const defaults={theme:'light',dailyGoal:30,reviewIntervals:{first:3,second:7,third:14}};
  data.settings=Object.fromEntries(SETTING_KEYS.map(key=>[key,settings.get(key,defaults[key]??null)]).filter(([,value])=>value!==null));
  return{app:'FE Study',formatVersion:BACKUP_FORMAT_VERSION,exportedAt:new Date().toISOString(),data};
}

export function validateBackup(value){
  if(!object(value)||value.app!=='FE Study')throw new Error('FE Studyのバックアップファイルではありません。');
  if(value.formatVersion!==BACKUP_FORMAT_VERSION)throw new Error(`未対応のバックアップ形式です（version ${String(value.formatVersion)}）。`);
  if(!date(value.exportedAt)||!object(value.data))throw new Error('バックアップの基本情報が正しくありません。');
  for(const store of DATA_STORES)if(!Array.isArray(value.data[store]))throw new Error(`data.${store} が配列ではありません。`);
  const d=value.data;
  const ids=new Set();
  for(const a of d.attempts){
    if(!object(a)||typeof a.id!=='string'||!a.id||ids.has(a.id)||typeof a.questionId!=='string'||!['A','B'].includes(a.subject)||typeof a.correct!=='boolean'||!Array.isArray(a.answer)||!date(a.answeredAt)||!Number.isFinite(a.elapsedSeconds)||a.elapsedSeconds<0||!['sure','unsure','guess'].includes(a.confidence))throw new Error('回答履歴に不正なデータ、または重複IDがあります。');
    ids.add(a.id);
  }
  for(const r of d.reviews)if(!object(r)||typeof r.questionId!=='string'||!date(r.dueAt)||!Number.isInteger(r.correctStreak)||r.correctStreak<0)throw new Error('復習情報の形式が正しくありません。');
  for(const b of d.bookmarks)if(!object(b)||typeof b.questionId!=='string')throw new Error('ブックマーク情報の形式が正しくありません。');
  for(const s of d.sessions)if(!object(s)||typeof s.id!=='string'||!Number.isFinite(s.durationSeconds)||s.durationSeconds<0)throw new Error('学習時間情報の形式が正しくありません。');
  for(const q of d.userQuestions){
    const validBlocks=blocks=>Array.isArray(blocks)&&blocks.length>0&&blocks.every(block=>{
      if(!object(block))return false;
      if(['text','code'].includes(block.type))return typeof block.text==='string';
      if(block.type==='image')return typeof block.src==='string'&&block.src.startsWith('data/')&&!block.src.split('/').includes('..')&&(block.alt===undefined||typeof block.alt==='string');
      if(block.type==='table')return Array.isArray(block.headers)&&block.headers.length>0&&block.headers.every(cell=>typeof cell==='string')&&Array.isArray(block.rows)&&block.rows.every(row=>Array.isArray(row)&&row.length===block.headers.length&&row.every(cell=>typeof cell==='string'));
      return false;
    });
    if(!object(q)||typeof q.id!=='string'||!['A','B'].includes(q.subject)||typeof q.field!=='string'||typeof q.topic!=='string'||!['single','multiple'].includes(q.format)||!validBlocks(q.prompt)||!Array.isArray(q.choices)||q.choices.length<2||!q.choices.every(choice=>object(choice)&&typeof choice.id==='string'&&validBlocks(choice.content))||!Array.isArray(q.answer)||!q.answer.length||!q.answer.every(id=>q.choices.some(choice=>choice.id===id))||typeof q.explanation!=='string')throw new Error('ユーザー追加問題の形式が正しくありません。');
  }
  for(const [name,rows,key] of [['reviews',d.reviews,'questionId'],['bookmarks',d.bookmarks,'questionId'],['sessions',d.sessions,'id'],['userQuestions',d.userQuestions,'id']]){const keys=rows.map(row=>row[key]);if(new Set(keys).size!==keys.length)throw new Error(`${name} に重複IDがあります。`);}
  if(d.settings!==undefined&&!object(d.settings))throw new Error('設定情報の形式が正しくありません。');
  if(d.settings?.theme!==undefined&&!['light','dark'].includes(d.settings.theme))throw new Error('テーマ設定の値が正しくありません。');
  if(d.settings?.dailyGoal!==undefined&&(!Number.isFinite(d.settings.dailyGoal)||d.settings.dailyGoal<1||d.settings.dailyGoal>1440))throw new Error('学習目標の値が正しくありません。');
  if(d.settings?.reviewIntervals!==undefined){const v=d.settings.reviewIntervals;if(!object(v)||!['first','second','third'].every(k=>Number.isInteger(v[k])&&v[k]>0&&v[k]<=365))throw new Error('復習間隔の値が正しくありません。');}
  if(d.settings?.questionCount!==undefined&&(!Number.isInteger(d.settings.questionCount)||d.settings.questionCount<1||d.settings.questionCount>100))throw new Error('出題数設定の値が正しくありません。');
  for(const key of ['showSubjectA','showSubjectB'])if(d.settings?.[key]!==undefined&&typeof d.settings[key]!=='boolean')throw new Error('科目表示設定の値が正しくありません。');
  return value;
}

export async function restoreBackup(backup,mode){
  validateBackup(backup);
  if(!['merge','replace'].includes(mode))throw new Error('復元方法を選択してください。');
  const current=mode==='merge'?await Promise.all(DATA_STORES.map(name=>all(name))):DATA_STORES.map(()=>[]);
  const records=Object.fromEntries(DATA_STORES.map((name,i)=>{
    const key=name==='attempts'||name==='sessions'||name==='userQuestions'?'id':'questionId';
    const merged=new Map(current[i].map(item=>[item[key],item]));
    for(const item of backup.data[name]){
      if(name==='attempts'&&merged.has(item.id))continue;
      merged.set(item[key],item);
    }
    return[name,[...merged.values()]];
  }));
  const currentSettings=mode==='merge'?Object.fromEntries(SETTING_KEYS.map(key=>[key,settings.get(key,null)]).filter(([,v])=>v!==null)):{};
  const mergedSettings={...currentSettings,...backup.data.settings};
  const previousRaw=Object.fromEntries(SETTING_KEYS.map(key=>[key,localStorage.getItem(`fe-study:${key}`)]));
  const rollbackSettings=()=>{for(const key of SETTING_KEYS){const raw=previousRaw[key];if(raw===null)localStorage.removeItem(`fe-study:${key}`);else localStorage.setItem(`fe-study:${key}`,raw);}};
  try{
    for(const key of SETTING_KEYS){if(Object.hasOwn(mergedSettings,key))settings.set(key,mergedSettings[key]);else localStorage.removeItem(`fe-study:${key}`);}
    const db=await openDB();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(DATA_STORES,'readwrite');
      for(const store of DATA_STORES){const table=tx.objectStore(store);if(mode==='replace')table.clear();for(const item of records[store])table.put(item);}
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('復元処理を取り消しました。'));tx.onerror=()=>reject(tx.error||new Error('復元中にエラーが発生しました。'));
    });
  }catch(error){try{rollbackSettings()}catch{}throw error;}
  return Object.fromEntries(DATA_STORES.map(name=>[name,backup.data[name].length]));
}

export async function clearStudyData(){
  const db=await openDB();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(DATA_STORES,'readwrite');for(const name of DATA_STORES)tx.objectStore(name).clear();
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('削除処理を取り消しました。'));tx.onerror=()=>reject(tx.error||new Error('削除中にエラーが発生しました。'));
  });
  for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key?.startsWith('fe-study:'))localStorage.removeItem(key);}
}
