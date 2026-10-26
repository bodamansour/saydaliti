# Minimal SQL Server 2000 (version 539) data file reader: decodes data pages using the system tables.
import struct, datetime, collections, decimal
P=8192
class MDF:
    def __init__(s,path):
        s.f=open(path,'rb'); s.f.seek(0,2); s.n=s.f.tell()//P
        s.pages=collections.defaultdict(list)
        for i in range(s.n):
            s.f.seek(i*P); h=s.f.read(96)
            if h[0]==1 and h[1]==1:
                obj,=struct.unpack_from('<i',h,24); s.pages[obj].append(i)
    def page(s,i): s.f.seek(i*P); return s.f.read(P)
    def records(s,obj):
        for pi in s.pages.get(obj,[]):
            b=s.page(pi); slots,=struct.unpack_from('<H',b,22)
            for k in range(slots):
                off,=struct.unpack_from('<H',b,P-2-2*k)
                if off<96 or off>=P: continue
                st=b[off]; rt=(st>>1)&7
                if rt not in (0,1): continue
                try: split(b,off)
                except Exception: continue
                yield b,off
def split(b,off):
    st=b[off]; fend,=struct.unpack_from('<H',b,off+2)
    fixed=b[off+4:off+fend]
    ncol,=struct.unpack_from('<H',b,fend+off)
    nb=(ncol+7)//8; nullmap=b[off+fend+2:off+fend+2+nb]
    p=off+fend+2+nb; var=[]
    if st&0x20:
        nv,=struct.unpack_from('<H',b,p); p+=2
        ends=[struct.unpack_from('<H',b,p+2*j)[0] for j in range(nv)]
        start=p+2*nv
        prev=start-off
        for e in ends:
            e2=e&0x7fff
            var.append(b[off+prev:off+e2]); prev=e2
    isnull=lambda ci: bool(nullmap[(ci-1)//8]>>((ci-1)%8)&1) if (ci-1)//8<len(nullmap) else False
    return fixed,var,isnull,ncol
def sysobjects(m):
    out={}
    for b,off in m.records(1):
        fixed,var,_,_=split(b,off)
        if len(fixed)<16: continue
        oid,=struct.unpack_from('<i',fixed,0); xt=fixed[4:6].decode('latin1').strip()
        name=var[0].decode('utf-16le','replace') if var else '?'
        out[oid]=(name,xt)
    return out
def syscolumns(m):
    cols=collections.defaultdict(list)
    for b,off in m.records(3):
        fixed,var,_,_=split(b,off)
        if len(fixed)<16: continue
        oid,=struct.unpack_from('<i',fixed,0)
        xtype=fixed[4]; length,=struct.unpack_from('<h',fixed,8)
        xprec=fixed[10]; xscale=fixed[11]
        colid,xoffset=struct.unpack_from('<hh',fixed,12)
        bitpos=fixed[16]
        name=var[0].decode('utf-16le','replace') if var else '?'
        cols[oid].append(dict(name=name,xtype=xtype,length=length,prec=xprec,scale=xscale,colid=colid,xoffset=xoffset,bitpos=bitpos))
    for v in cols.values(): v.sort(key=lambda c:c['colid'])
    return cols

def decode(c, fixed_rec, var, isnull, ncol):
    t=c['xtype']; L=c['length']; xo=c['xoffset']
    if c['colid']<=ncol and isnull(c['colid']): return None
    if xo<0:
        i=-xo-1
        if i>=len(var): return None
        raw=var[i]
    else:
        if t==104:
            return bool(fixed_rec[xo]>>c['bitpos']&1) if xo<len(fixed_rec) else None
        raw=fixed_rec[xo:xo+L]
        if len(raw)<L: return None
    try:
        if t==56: return struct.unpack('<i',raw)[0]
        if t==52: return struct.unpack('<h',raw)[0]
        if t==48: return raw[0]
        if t==127: return struct.unpack('<q',raw)[0]
        if t==62: return struct.unpack('<d',raw)[0] if L==8 else struct.unpack('<f',raw)[0]
        if t==59: return struct.unpack('<f',raw)[0]
        if t==60: return struct.unpack('<q',raw[4:]+raw[:4])[0]/10000 if False else ( (struct.unpack('<i',raw[4:8])[0] & 0xffffffff | 0) )
        if t==122: return struct.unpack('<i',raw)[0]/10000
        if t in (106,108):
            sign=raw[0]; v=int.from_bytes(raw[1:],'little'); v=v/(10**c['scale']); return v if sign==1 else -v
        if t==61:
            tk,d=struct.unpack('<ii',raw); return (datetime.datetime(1900,1,1)+datetime.timedelta(days=d,seconds=tk/300)).isoformat()
        if t==58:
            mi,d=struct.unpack('<HH',raw); return (datetime.datetime(1900,1,1)+datetime.timedelta(days=d,minutes=mi)).isoformat()
        if t in (167,175,35): return raw.decode('cp1256','replace').rstrip()
        if t in (231,239,99): return raw.decode('utf-16le','replace').rstrip()
        if t==36: return raw.hex()
        return raw.hex()
    except Exception: return None

def money(raw):
    return struct.unpack('<q',raw)[0]/10000

def rows(m, oid, cols):
    for b,off in m.records(oid):
        st=b[off]; fend,=struct.unpack_from('<H',b,off+2)
        rec=b[off:off+fend]
        fixed,var,isnull,ncol=split(b,off)
        r={}
        for c in cols:
            if c['xtype']==60 and c['xoffset']>0:
                raw=rec[c['xoffset']:c['xoffset']+8]
                r[c['name']]=None if (c['colid']<=ncol and isnull(c['colid'])) or len(raw)<8 else money(raw)
            else:
                r[c['name']]=decode(c,rec,var,isnull,ncol)
        yield r
