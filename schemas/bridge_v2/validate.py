"""Valida exemplos (positivos e negativos) contra os schemas bridge_v2. Uso: python validate.py"""
import json,glob,os,sys,copy
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
H=os.path.dirname(os.path.abspath(__file__))
S={json.load(open(p))["$id"]:json.load(open(p)) for p in glob.glob(H+"/*.schema.json")}
reg=Registry().with_resources([(k,Resource.from_contents(v)) for k,v in S.items()])
def V(n): s=json.load(open(f"{H}/{n}.schema.json")); Draft202012Validator.check_schema(s); return Draft202012Validator(s,registry=reg)
ok=True
for p in sorted(glob.glob(H+"/examples/*.json")):
    n=os.path.basename(p)[:-5]; errs=list(V(n).iter_errors(json.load(open(p))))
    print(("PASS" if not errs else "FAIL"),n,[e.message for e in errs][:3]); ok&=not errs
st=json.load(open(H+"/examples/state.json"))
neg={"state sem policy_controlled":({k:v for k,v in st.items() if k!="policy_controlled"},"state"),
     "state truncated sem reason":(dict(st,truncated=True),"state"),
     "state vivo com máscara toda 0":(dict(st,action_mask=[0]*512),"state"),
     "state máscara 511 itens":(dict(st,action_mask=[1]*511),"state"),
     "step sem decision_id":({"cmd":"step","request_id":3,"action":1},"step.request"),
     "error código inválido":({"type":"error","request_id":1,"code":"OOPS","message":"x","fatal":False},"error"),
     "hello protocolo 1":({"cmd":"hello","request_id":1,"protocol":1},"hello.request")}
for d,(doc,n) in neg.items():
    rej=bool(list(V(n).iter_errors(doc))); print(("PASS" if rej else "FAIL"),"rejeita:",d); ok&=rej
sys.exit(0 if ok else 1)
