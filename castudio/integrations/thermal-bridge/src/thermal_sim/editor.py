"""Owned-process helpers for the local thermal editor service."""
import argparse
import json
from pathlib import Path
import tempfile

from ._backend import load
from .bridge import resolve_config
from .selection import resolve, validate_config


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['schema','resolve','validate'])
    parser.add_argument('--surface')
    parser.add_argument('--request')
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='coserve-thermal-editor-') as scratch:
        schemas,*_=load(scratch)
        if args.action=='schema':
            from .__main__ import portable_schema
            from . import __version__
            value=dict(schema=portable_schema(schemas.Simulation.model_json_schema()),materials=schemas.PRESETS,version=__version__)
        else:
            surface=json.loads(Path(args.surface).read_text(encoding='utf-8'))
            request=json.loads(Path(args.request).read_text(encoding='utf-8'))
            if args.action=='resolve':value=resolve(surface,request)
            else:
                cfg=resolve_config(request, surface,surface['source_sha256'])
                validate_config(cfg,surface,schemas)
                value=dict(ok=True)
    print('THERMAL_RESULT='+json.dumps(value,ensure_ascii=False,allow_nan=False),flush=True)


if __name__=='__main__':main()
