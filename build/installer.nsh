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

!macro customInit
  ${if} ${FileExists} "$INSTDIR\PasteTalk models\*.*"
    ClearErrors
    Rename "$INSTDIR\PasteTalk models" "$INSTDIR.models-keep"
    ${if} ${Errors}
      DetailPrint "PasteTalk models: не удалось вынести на время обновления"
    ${endif}
  ${endif}
!macroend

!macro customInstall
  ${if} ${FileExists} "$INSTDIR.models-keep\*.*"
    ClearErrors
    Rename "$INSTDIR.models-keep" "$INSTDIR\PasteTalk models"
    ${if} ${Errors}
      DetailPrint "PasteTalk models: не удалось вернуть на место, папка осталась рядом: $INSTDIR.models-keep"
    ${endif}
  ${endif}
!macroend
