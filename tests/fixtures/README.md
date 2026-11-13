# PDF integration fixtures

`native-preview.pdf` is an inert, three-page document generated with ReportLab Canvas (`invariant=1`). Page sizes are 612×792, 792×612 and 595×842 pt; red, blue and green blocks distinguish pages. Poppler PNG renders of all pages were visually checked when the fixture was created.

`native-preview-locked.pdf` contains the same pages, encrypted by pypdf with the synthetic test password `fixture-password`. The ordinary PDF test checks the initial password-required state. The password test enters wrong and correct passwords through the native form, then renders all three pages through Poppler GLib in a disposable GJS process.

These files are test inputs. Tests require neither authoring library, only the Poppler tools and GLib introspection bindings shipped with the app.

`question-material.webm` — синтетический 32×24 синий кадр, VP9/WebM, 2 fps, 1 s, без аудио. Создан локально через ffmpeg lavfi color для проверки нативного просмотра материалов вопроса; внешних медиа нет.
