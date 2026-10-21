# Эксплуатация, проверка и публикация

[README](../README.md) · [Устройство сервиса](architecture.md) · [Настройки](configuration.md)

Команды ниже выполняются из каталога `twbit` в PowerShell.
Нужен Docker с Compose; Bun, FFmpeg, модель и библиотеки устанавливаются в образ.

## Первый запуск

```powershell
Copy-Item config.example.json config.json
# Заполните корневой accessToken своим Twitch OAuth-токеном.
docker run --rm --mount "type=bind,source=${PWD},target=/workspace" -w /workspace --entrypoint bun oven/bun:1.4.3 run scripts/prepare-database.ts
docker compose build twbit
docker compose up -d --no-build
docker compose logs -f twbit
```

Копирование конфига нужно только при первом запуске в новом каталоге.
Подготовка создаёт два случайных пароля в `.secrets/` и сохраняет существующие.
Пример конфига выключает AI: чтение чата и распознавание работают отдельно.
Для AI заполните `ai.accessToken` и включите `ai.enabled`.
Сначала `delivery=console_only` выводит черновики; `chat` включает реальную отправку.

Compose запускает `twbit` и `postgres`. База находится в именованном томе
`postgres_data`; порт PostgreSQL на хост не публикуется. Миграции применяются
приложением автоматически. Уже применённые SQL-файлы не редактируются.

## Обновление и диагностика

```powershell
# После изменения только конфига.
docker compose restart twbit

# После изменения исходников: сборка отдельно, затем применение.
docker compose build twbit
docker compose up -d --no-deps --no-build twbit

docker compose ps
docker compose logs --tail=100 twbit
docker compose logs --tail=100 postgres
docker stats --no-stream

# Остановка приложения; PostgreSQL продолжит работать.
docker compose stop twbit

# Остановка проекта с сохранением тома базы.
docker compose down
```

Не добавляйте `--volumes` к остановке, если нужно сохранить базу.
Исходники не смонтированы в приложение: запущенный контейнер использует код
своего образа. Новый образ сам по себе не обновляет работающий экземпляр.
Не запускайте вторую обычную копию с `delivery=chat` для проверки новой версии.

## Проверки без Twitch и платных AI-запросов

```powershell
# Сборка уже содержит typecheck и unit/mock-тесты под RUN --network=none.
docker build --target app -t twbit:local .

# Повторные проверки готового образа без сети, конфига и секретов.
docker run --rm --network none --entrypoint bun twbit:local run typecheck
docker run --rm --network none --entrypoint bun twbit:local test
docker run --rm --network none --entrypoint bun twbit:local run smoke:speech
```

Стадии скачивания пакетов, моделей и системных зависимостей при первой сборке
требуют сеть. Сама стадия typecheck/test отключает сеть. Unit-тесты используют
подменённые HTTP-клиенты и отправители, рабочий конфиг не читают.

PostgreSQL-интеграционные тесты пропускаются без `TEST_DATABASE_URL`. Для них
нужна отдельная пустая временная база, куда допускается создание схемы `twbit`.
Не задавайте URL рабочей базы и не монтируйте её том в тестовый контейнер.
Файлы: `memory-postgres.test.ts`, `history-postgres.test.ts`,
`greeting-postgres.test.ts`; тестовые операции откатываются транзакцией.

`--check` — отдельная диагностика приложения: без `--speech-only` она проверяет
токен реальным запросом в Twitch; с `--speech-only` загружает ASR-модель.
`--once` и `--duration` ограничивают работу, но сами по себе не выключают AI.

## История, расход и память

```powershell
# База должна уже работать. Эти команды не вызывают Twitch или AI.
docker compose run --rm --no-deps --entrypoint bun twbit run db:stats
docker compose run --rm --no-deps --entrypoint bun twbit run db:history --limit=20
docker compose run --rm --no-deps --entrypoint bun twbit run db:history --all --context --limit=30
```

Для истории доступны `--user-id=123`, `--id=UUID`, `--outcome=send_failed`,
`--prompt`. По умолчанию выбираются только подтверждённые `sent`;
`--all` включает молчание, отбраковку и ошибки.
CLI базы вызывает инициализацию и применяет недостающие миграции перед запросом.
`db:check` дополнительно проверяет запись и сводку в откатываемой транзакции.

Usage генерации и проверки хранится отдельными строками. `NULL` в счётчике
означает неизвестный расход. Cached/reasoning входят в input/output;
повторно прибавлять их к общему числу токенов не нужно. Денежные тарифы код не хранит.

Для просмотра памяти через psql можно использовать транзакцию только для чтения:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT login, kind, content, observed_at, evidence
FROM twbit.user_memories
WHERE channel = 'licrige' AND expires_at > now()
ORDER BY observed_at DESC
LIMIT 30;
ROLLBACK;
```

## Логи и типовые причины молчания

| Событие / код | Что проверять |
|---|---|
| `ai.limits`, `ai.analysis` | Мышление, реальный бюджет генерации и размер контекста |
| `ai.skip` | Решение модели либо причина отбраковки |
| `ai.stale`, `RESPONSE_DEADLINE` | Повод успел устареть; увеличение одного API-таймаута не помогает |
| `TIMEOUT` | Истёк таймаут API; проверьте задержку, мышление и лимиты |
| `ai.review_unavailable` | Проверка смысла не завершилась, отправка пропущена |
| `ai.send_failed` | Нет подтверждения Twitch; смотрите причину IRC/API, повтора нет |
| `msg_automod_held` | Twitch удержал сообщение на проверке, публикация не подтверждена |
| `memory.saved`, `memory.filtered` | Сохранение или отбраковка предложений памяти |
| `database.unavailable`, `database.queue_full` | База недоступна либо очередь записи переполнена |
| `DATABASE_MIGRATION_CHECKSUM_CHANGED` | Изменён применённый SQL-файл, нужен исходный файл и новая миграция |

В `console_only` ответы остаются в логах. В режиме чата тишина также возможна
при недостаточных правах, выбранном `skip`, общей паузе или занятом анализе.
Для эфира добавляются доступность стрима и задержка/ошибки ASR.

## Резервное копирование

Регулярный backup пока не автоматизирован. Пример сохраняет дамп на хост,
без перенаправления бинарного вывода через PowerShell:

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
docker compose exec -T postgres pg_dump -U postgres -d twbit -Fc -f /tmp/twbit-backup.dump
docker compose cp postgres:/tmp/twbit-backup.dump ./backups/twbit-backup.dump
```

Имя файла фиксировано: следующая копия заменит предыдущую. Для нескольких
снимков выбирайте отдельные имена. Сохраняйте `config.json` и `.secrets/`
отдельно от исходников. Новый пароль в файле сам по себе не меняет пароль роли
в уже созданной базе. Каталог `backups/` и дампы исключены из Git и Docker-контекста.

## Публикация исходников

В Git должны попасть исходники, `bun.lock`, тесты, миграции, Docker-файлы,
документация и `config.example.json`. Приватный конфиг, все варианты `.env`,
пароли, модели, записи звука, логи, дампы и зависимости исключены.
Приложение не загружает ключи из MCP.

Проверьте расположение Git-корня. В отдельном репозитории сервиса он совпадает
с каталогом `twbit`, где находятся этот файл настроек и исходники.
Если сервис лежит внутри родительского репозитория, добавляйте только его каталог
и нужные корневые файлы; соседний старый коллектор в публикацию не входит.

Проверка и добавление из корня отдельного репозитория сервиса:

```powershell
git rev-parse --show-toplevel
git status --short --untracked-files=all
git add --dry-run -- .

# Когда список файлов проверен.
git add -- .
git diff --cached --stat
git diff --cached --check
```

Для первого коммита задайте автора только в этом репозитории. Можно использовать
свой GitHub noreply-адрес из настроек аккаунта:

```powershell
git config --local user.name "YOUR_NAME"
git config --local user.email "YOUR_GITHUB_NOREPLY_EMAIL"
git commit -m "Add twbit service"
git push -u origin main
```

Перед push должен существовать хотя бы один успешный коммит. Если commit завершился
ошибкой `unable to auto-detect email address`, исправьте автора и повторите commit;
переименование ветки само по себе не создаёт её первый коммит.
`.gitignore` не удаляет уже отслеживаемые секреты из индекса или истории.
