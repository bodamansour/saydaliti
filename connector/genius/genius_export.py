# Genius (SQL Server 2000 format) backup -> data.json for Saydaliti, without SQL Server and without the backup password.
# Usage: python3 genius_export.py <backup.gen> <out data.json> [--since YYYY-MM-DD]
# Reads only items, stock, daily sales and purchases. No customer data.
# Prefer genius-export.mjs (Node): it reads the backup in place and writes no database copy.
# This one rebuilds the data file in a temporary file, which is always deleted at the end (even on errors).
import sys,os,json,collections,datetime,struct,tempfile
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from mdf2000 import *
src,dst=sys.argv[1],sys.argv[2]
since=sys.argv[sys.argv.index('--since')+1] if '--since' in sys.argv else (datetime.date.today()-datetime.timedelta(days=365)).isoformat()

def rebuild(src, out_path):
    """A full backup stores the data file's pages; put each page back at its page number."""
    f=open(src,'rb'); f.seek(0,2); size=f.tell()
    align=collections.Counter()
    f.seek(0); b=f.read(min(size,64<<20))
    for i in range(0,len(b)-96,512):
        if b[i]==1 and b[i+1] in (1,2) and struct.unpack_from('<H',b,i+36)[0]==1: align[i%8192]+=1
    off=align.most_common(1)[0][0]
    out=open(out_path,'wb'); f.seek(off); maxp=0
    while True:
        pg=f.read(8192)
        if len(pg)<8192: break
        if pg[0]!=1: continue
        pid,fid=struct.unpack_from('<IH',pg,32)
        if fid!=1 or pid>4_000_000: continue
        out.seek(pid*8192); out.write(pg); maxp=max(maxp,pid)
    out.truncate((maxp+1)*8192); out.close()

fd,tmp=tempfile.mkstemp(prefix='saydaliti_genius_',suffix='.mdf'); os.close(fd)
try:
  rebuild(src,tmp)
  m=MDF(tmp)
  so=sysobjects(m); sc=syscolumns(m)
  B={so[o][0]:o for o in so if so[o][1]=='U'}
  def R(t): return [r for r in rows(m,B[t],sc[B[t]]) if any(v is not None for v in r.values())]
  def day(s):
      if not s: return None
      d=s[:10]
      return d if '2015-01-01'<=d<=str(datetime.date.today().year+1)+'-12-31' else None
  ok=lambda v,hi=1e6: isinstance(v,(int,float)) and 0<=v<hi
  cat=R('Item_Catalog'); print('catalog',len(cat))
  units={}; items={}
  for r in cat:
      if not ok(r['itm_id'],1e9): continue
      code=str(int(r['itm_id']))
      u2=r['itm_unit1_unit2'] if ok(r['itm_unit1_unit2'],1e4) and r['itm_unit1_unit2']>0 else 1
      u3=r['itm_unit1_unit3'] if ok(r['itm_unit1_unit3'],1e5) and r['itm_unit1_unit3']>0 else u2
      units[code]=(u2,u3)
      items[code]=dict(code=code,name=(r['itm_name_ar'] or r['itm_name]en'] or code).strip(),
          category='أدوية' if r['itm_ismedicine']==1 else 'غير دوائي',
          cost=r['itm_def_pharm_price'] if ok(r['itm_def_pharm_price'],1e5) else 0,
          price=r['itm_def_sell_price'] if ok(r['itm_def_sell_price'],1e5) else 0, owner=None, qty=None, expiry=None,
          active=r['itm_active']=='1')
  batches=[]; bcost=collections.defaultdict(list)
  for r in R('Item_Class_Store'):
      if not ok(r['itm_id'],1e9) or not ok(r['itm_qty'],1e5) or r['itm_qty']<=0: continue
      code=str(int(r['itm_id']))
      if code not in items: continue
      exp=day(r['itm_expiry_date']) if r['itm_expiry_date'] and r['itm_expiry_date'][:4]>='2000' else None
      batches.append(dict(code=code,qty=round(r['itm_qty'],2),expiry=exp))
      if ok(r['pharm_price'],1e5) and r['pharm_price']>0: bcost[code].append((r['pharm_price'],r['sell_price']))
  for code,v in bcost.items():
      items[code]['cost']=v[-1][0]
      if ok(v[-1][1],1e5) and v[-1][1]>0: items[code]['price']=v[-1][1]
  # Genius keeps its own daily stock snapshot: use the latest day as the true quantity per item
  snap={}; lastday=0
  for r in R('Item_Daily_Stock'):
      d=r['ids_day']
      if isinstance(d,int) and 20180101<=d<=20261231 and ok(r['ids_qty'],1e6): 
          if d>lastday: lastday=d
  for r in R('Item_Daily_Stock'):
      if r['ids_day']==lastday and isinstance(r['ids_itm_id'],int) and ok(r['ids_qty'],1e6):
          snap[str(r['ids_itm_id'])]=(r['ids_qty'], r['ids_purchasePrice'], r['ids_sellPrice'])
  print('snapshot day',lastday,'items',len(snap))
  byc=collections.defaultdict(list)
  for bt in batches: byc[bt['code']].append(bt)
  fixed=[]
  for code,(q,pp,sp) in snap.items():
      if code not in items or q<=0: continue
      rem=q
      for bt in sorted(byc.get(code,[]), key=lambda x:x['expiry'] or '9999', reverse=True):
          take=min(bt['qty'],rem)
          if take>0: fixed.append(dict(code=code,qty=round(take,2),expiry=bt['expiry'])); rem-=take
      if rem>0.001: fixed.append(dict(code=code,qty=round(rem,2),expiry=None))
      if ok(pp,1e5) and pp>0: items[code]['cost']=pp
      if ok(sp,1e5) and sp>0: items[code]['price']=sp
  batches=fixed
  print('batches',len(batches),'items with stock',len({b['code'] for b in batches}))
  hdr={}
  for r in R('sales_trans_h'):
      if ok(r['sth_id'],1e9): hdr[int(r['sth_id'])]=day(r['sec_insert_date'])
  agg=collections.defaultdict(lambda:[0.0,0.0,0.0])
  for r in R('sales_trans_d'):
      if not ok(r['itm_id'],1e9) or r['itm_unit'] not in (1,2,3) or not ok(r['qnty'],1e4): continue
      code=str(int(r['itm_id'])); d=day(r['sec_insert_date']) or hdr.get(int(r['sth_id'] or 0))
      if not d or d<since or code not in items: continue
      u2,u3=units[code]; f={1:1,2:u2,3:u3}[r['itm_unit']]
      back=r['itm_back'] if ok(r['itm_back'],1e4) else 0
      q=(r['qnty']-back)/f
      if q<=0: continue
      sell=r['itm_sell'] if ok(r['itm_sell'],1e5) else 0
      disc=r['itm_dis_mon'] if ok(r['itm_dis_mon'],1e5) else 0
      a=agg[(code,d)]; a[0]+=q; a[1]+=sell*(r['qnty']-back); a[2]+=disc
  sales=[dict(code=c,date=d,qty=round(v[0],3),amount=round(v[1],2),discount=round(v[2],2)) for (c,d),v in agg.items()]
  print('sales rows',len(sales),'days',len({s['date'] for s in sales}), 'last',max(s['date'] for s in sales))
  ph={}
  for r in R('pur_trans_h'):
      i=r.get('pth_id'); 
      if ok(i,1e9): ph[int(i)]=day(r.get('sec_insert_date')) or day(r.get('pth_date')) 
  purch=collections.defaultdict(lambda:[0.0,0.0,0.0])
  for r in R('pur_trans_d'):
      if not ok(r['itm_id'],1e9) or not ok(r['qnty'],1e5): continue
      code=str(int(r['itm_id'])); d=day(r['sec_insert_date']) or ph.get(int(r['pth_id'] or 0))
      if not d or d<since or code not in items: continue
      p=purch[(code,d)]; c=r['itm_cost'] if ok(r['itm_cost'],1e5) else 0
      p[0]+=r['qnty']+(r['bonus'] if ok(r['bonus'],1e5) else 0); p[1]+=r['qnty']; p[2]+=r['qnty']*c
  purchases=[dict(code=c,date=d,qty=round(v[0],3),cost=round(v[2]/v[1],2) if v[1] else 0) for (c,d),v in purch.items()]
  print('purchase rows',len(purchases))
  stocked={b['code'] for b in batches}; sold={s['code'] for s in sales}
  out=dict(exportedAt=datetime.datetime.now().isoformat(timespec='seconds'),source='genius-backup',
    items=[{k:v for k,v in i.items() if k!='active'} for i in items.values() if i['active'] or i['code'] in stocked or i['code'] in sold],
    batches=batches,sales=sales,purchases=purchases)
  json.dump(out,open(dst,'w',encoding='utf-8'),ensure_ascii=False)
finally:
  try: m.f.close()
  except Exception: pass
  if os.path.exists(tmp): os.remove(tmp)
print('items out',len(out['items']))
