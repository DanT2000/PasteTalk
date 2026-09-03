; Дополнения к установщику PasteTalk (electron-builder → nsis.include).
;
; Модели могут лежать в папке установки — человек вправе выбрать её в
; «Куда складывать модели». Но обновление сначала удаляет прежнюю версию
; ЦЕЛИКОМ, папку установки со всем содержимым, — и модели на гигабайты
; исчезали при каждом выпуске.
;
; Поэтому новый установщик ещё до удаления старой версии выносит папку
; «PasteTalk models» на шаг в сторону — переименованием на том же диске,
; это мгновенно, — а после установки возвращает на место. Выносит именно
; НОВЫЙ установщик, а не старый деинсталлятор: так это работает и при
; обновлении с версий, которые про модели ничего не знали.
;
; customInit выполняется в .onInit, когда $INSTDIR уже прочитан из реестра
; (место прежней установки). При автообновлении приложение к этому моменту
; закрыто; при ручной установке поверх — файлы моделей движок держит
; закрытыми, переименование проходит.

; Откуда вынесли модели: в мастере человек может выбрать другую папку,
; и возвращать надо из старого места в новое, а не искать рядом с новым.
; Только установщику: в сборке деинсталлятора макросы не вставляются, и
; NSIS счёл бы переменную лишней (а предупреждение здесь — ошибка).
!ifndef BUILD_UNINSTALLER
  Var ptModelsKept
!endif

!macro customInit
  StrCpy $ptModelsKept ""
  ; Где стоит прежняя версия — из реестра: при запуске с /D=другая_папка
  ; $INSTDIR уже указывает на новую, а модели лежат в старой.
  ReadRegStr $R7 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R7 == ""
    StrCpy $R7 $INSTDIR
  ${endif}
  ${if} ${FileExists} "$R7\PasteTalk models\*.*"
    ClearErrors
    Rename "$R7\PasteTalk models" "$R7.models-keep"
    ${if} ${Errors}
      DetailPrint "PasteTalk models: не удалось вынести на время обновления"
    ${else}
      StrCpy $ptModelsKept "$R7.models-keep"
    ${endif}
  ${endif}
!macroend

!macro customInstall
  ${if} $ptModelsKept != ""
  ${andIf} ${FileExists} "$ptModelsKept\*.*"
    ClearErrors
    Rename "$ptModelsKept" "$INSTDIR\PasteTalk models"
    ${if} ${Errors}
      DetailPrint "PasteTalk models: не удалось вернуть на место, папка осталась: $ptModelsKept"
    ${endif}
  ${endif}
!macroend
