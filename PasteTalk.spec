# -*- mode: python ; coding: utf-8 -*-

import pathlib
base_path = str(pathlib.Path(".").absolute())

block_cipher = None

a = Analysis(
    ['main.py'],
    pathex=[base_path],
    binaries=[],
    datas=[
        ('config.json', '.'),  # конфиг
        ('1.ico', '.'),        # иконка (если есть)
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='PasteTalk',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='PasteTalk'
)
