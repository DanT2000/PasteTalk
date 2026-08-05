"""Точка входа для собранного движка.

PyInstaller не умеет запускать пакет через `-m`, поэтому ему нужен
обычный файл-скрипт, который делает то же самое.
"""

import multiprocessing
import sys

from pastetalk_engine.server import main

if __name__ == "__main__":
    # Без этого собранный exe при любом порождении процесса запускал бы
    # сам себя заново — классическая ловушка PyInstaller на Windows.
    multiprocessing.freeze_support()
    sys.exit(main())
