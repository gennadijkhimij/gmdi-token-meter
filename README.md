# gmdi-token-meter

Мод для Claude Code (застосунок Claude, вкладка Code, і термінал): смуга над полем вводу з лімітами, станом кешу запитів і ціною продовження розмови.

```
▾ ЛІМІТИ 7Д ●●●●●●···· 59% вільно · 3д 7г  5Г ●●●●●●●●●● 97% вільно · 2г 58хв  ТЕПЛО ще 1г 00хв ↻4 → $1.66
```

*English below.*

## Що показує

- **7Д і 5Г** — скільки лишилося тижневого й п'ятигодинного лімітів і коли вони скинуться. Колір: ≥80 % жовтий, ≥40 % помаранчевий, менше червоний. Цифри лімітів Claude надсилає лише разом із відповіддю. Тому, коли час скидання минув, а сесія простоює, мод сам вважає вікно вільним (100 %, без ⚠). У деталях тоді видно «скинуто 14:17, точні дані — з наступною відповіддю».
- **ТЕПЛО / ХОЛОД** — чи ще живий кеш запитів після останньої відповіді і скільки йому лишилося (TTL 1h на підписці, 5m на API-ключі).
- **→ $X** — скільки коштуватиме перший запит, коли кеш охолоне й контекст доведеться записати заново.
- **▾** розгортає деталі: скидання лімітів за київським часом і прогноз на кінець вікна, стан кешу, ціна продовження, ціни для інших моделей, контекст і вартість сесії.
- **⚙** — налаштування: мова (uk/en), які блоки показувати, TTL кешу, прогрівач, поріг попереджень, бюджет доплат, пропозиція стиснення та автостиснення.

## Попередження про ліміти й доплати

Працює для будь-якого входу: Free, Pro, Max, Team, Enterprise, API-ключ, шлюз.

- **Ліміти.** Коли вікно (тиждень, 5 годин, `spend_limit` шлюзу) заповнене на 80 % (у ⚙: 70/80/90 % або «вимк»), біля нього з'являється **⚠**, а мод один раз показує сповіщення. Воно каже, коли ліміт закінчиться за поточного темпу і коли скинеться. На 95 % сповіщення повторюється і пояснює, що буде далі: доплати чи зупинка до скидання.
- **Доплати підписки (extra usage).** Мод читає ті самі дані, що й `/usage` у Claude Code: увімкнено чи ні, скільки списано за місяць, стелю організації. На смузі з'являється `доплати $52/$150`, у деталях — рядок «Доплати». Сповіщення приходять, коли доплати почалися, на ⅓, ⅔ і 14/15 стелі (для $150 це $50/$100/$140) і коли стелю досягнуто.
- **Бюджет у ⚙** ($50–500 на місяць) — ваша особиста стеля. Якщо вона нижча за стелю організації, попередження рахуються від неї. Гроші при цьому списуються й далі: зупиняє роботу лише стеля в адмінці claude.ai.
- **API-ключ.** Тут платний кожен запит, тож мод сам рахує витрати місяця за вартістю сесій на цьому комп'ютері й попереджає на частках бюджету з ⚙.
- Кожне попередження показується один раз, навіть якщо відкрито кілька сесій. Дані сервера читає одна сесія не частіше ніж раз на 5 хвилин і ділиться ними з іншими: сервер відповідає 429, якщо питати частіше.

## Прогрівач кешу

Щоб простійна сесія не охолола і не довелося платити за повний перезапис контексту, мод за 5 хв до кінця TTL (за 1 хв при 5m) сам надсилає в сесію короткий запит «відповідай: ок». Запит читає кеш і продовжує його ще на TTL: ≈$0.04 замість ≈$1.66 за 200k контексту на Opus 5.5.

- Типово до **4** разів поспіль, у ⚙ можна 2, 8 або «вимк». Ваше повідомлення скидає лічильник.
- Не прогріває, поки Claude працює, при контексті менше 20k, коли лишилося < 10 % ліміту 5Г або < 5 % тижневого, і коли кеш уже холодний.
- `↻N` у смузі — скільки прогрівів ще лишилося. ▾ → «Прогрів»: коли наступний і скільки зроблено; кнопка «⏸ Не прогрівати цю сесію».
- Прогрів витрачає ліміт: кожен запит — це окремий хід моделі. Працює, лише поки сесія відкрита й комп'ютер не спить.

## Стиснення, поки кеш теплий

Коли розмова велика, перший запит після години простою записує в кеш увесь контекст заново: для 804k токенів на Opus 5.5 це ≈$6.43 (запис 1h = вхід × 2). Стиснення (`/compact`) тим часом коштує одне читання контексту з теплого кешу і вихід підсумку: ≈$0.16 + $0.16. Після нього охолодження перезаписує лише підсумок і системний промпт (≈70k, ≈$0.56).

- **Пропозиція.** Кеш теплий, до охолодження лишилося ≤15 хв (у ⚙: 10/15/20 хв або «вимк»), охолодження коштуватиме понад $1 (у ⚙: $0.5/1/2/5), а стиснення разом із наступним холодним стартом обійдеться щонайменше вдвічі дешевше. Тоді під смугою з'являється рядок:
  `⚠ кеш охолоне за 14хв: стиснути зараз ≈$0.32, потім охолодження ≈$0.56 замість $6.43  [⇲ Стиснути зараз] не зараз`
  На вузькій смузі текст коротшає. «Не зараз» ховає рядок до наступної відповіді.
- **Кнопка «⇲ Стиснути зараз»** (у рядку пропозиції та в деталях ▾ → «Стиснення») запускає те саме стиснення, що й `/compact`. У терміналі мод викликає `$.session.compact()`. Застосунок Claude (вкладка Code) такого виклику модам не дозволяє, тож там мод одразу виконує команду `/compact` від свого імені (`$.command.run`); у розмові це видно як рядок `/compact … Compacted`. Якщо Claude саме працює або починає відповідь, поки мод готує стиснення, мод нічого не запускає й пояснює це сповіщенням. Якщо стиснення заборонив інший хук (і в терміналі, і під час `/compact` у застосунку) або воно не вдалося, причина з'явиться в сповіщенні й у деталях, а смуга й далі рахує великий контекст. Поки стиснення триває, у смузі видно «стискаю сесію…».
- **Автостиснення** (⚙, типово вимкнене). Коли пропозиція стоїть, сесія простоює і до охолодження лишилося 5 хв (1 хв при TTL 5m), мод стискає сесію сам: один раз на кожен кеш, не після «не зараз» і не під час ходу. Після стиснення приходить сповіщення «сесію стиснуто автоматично: 804k → 62k».
- **Прогрівач і стиснення.** Поки прогрівач тримає кеш теплим, пропозиції в смузі немає. У деталях тоді видно, що вигідніше: «прогрів дешевший, якщо перерва до ≈3г 50хв; довша — стиснути» (кожен прогрів — окремий запит, що читає весь контекст і продовжує кеш на TTL мінус 5 хв запасу — 1 хв при 5m; рахуються цілі прогріви; після останнього кеш однаково охолоне). Коли прогрівач вимкнено, поставлено на паузу, прогріви вичерпано чи він стоїть через «мало ліміту 7Д / 5Г», мод пропонує стиснення й пише причину: «вигідніше стиснути: прогрівач стоїть, мало ліміту 7Д».
- **Деталі «Стиснення»:** ціна зараз, ціна охолодження після нього, ціна кожного наступного запиту («запит $0.014 замість $0.16») і нагадування, що подробиці розмови замінить підсумок.
- **Точність.** Розмір контексту після стиснення (70k) і довжина підсумку (8k) спершу оцінкові. Після першого стиснення на цьому комп'ютері мод запам'ятовує справжні числа (розмір — той, що назвав рушій, а якщо рушій його не назвав, — з відповіді на наступний хід; навіть якщо контекст лишився великим) і бере їх для наступних оцінок. Кеш підсумку прив'язаний до моделі сесії: якщо після стиснення перемкнути `/model`, смуга покаже ХОЛОД. Це стосується й стиснень, які ви робите самі через `/compact`, якщо мод їх чує: інший плагін, який обробляє стиснення раніше за мод (наприклад, плагін безпеки організації), може їх від мода приховати. Після стиснення в застосунку рушій не знає розміру контексту до наступної відповіді; до того смуга рахує за оцінкою.
- **Обмеження.** Стиснення замінює розмову підсумком, і дрібні подробиці губляться. Рушій не дає стискати посеред ходу, тому мод чекає, поки сесія простоює. Ціни — за прайсом API; на підписці це міра витраченого ліміту.

## Поріг автостиснення

Рушій Claude Code стискає розмову сам, коли контекст доходить до **вікна автостиснення мінус ≈33k**. Типове вікно — повне вікно моделі, тож на моделі з 1M розмова розростається майже до мільйона токенів, і кожен запит читає весь цей контекст.

- **⚙ «Поріг автостиснення»:** як у рушія / 100k / ★ 200k (рекомендовано) / 300k / 400k. Натискання одразу виконує команду рушія `/autocompact <N>`, без перезапуску. Рушій сам записує вибір для моделі в `settings.json` (`modelSettings.<модель>.autoCompactWindow`). «Як у рушія» виконує `/autocompact auto`. Якщо рушій відмовив (наприклад, задано змінну `CLAUDE_CODE_AUTO_COMPACT_WINDOW`), причина з'явиться у сповіщенні, а вибір не збережеться.
- **Інші сесії** отримують вибір самі, коли простоюють, один раз для кожної моделі.

| вікно | стисне на | |
|---|---|---|
| 100k | ≈67k | найекономніше, частіші підсумки |
| ★ 200k | ≈167k | рекомендовано: баланс пам'яті розмови й ліміту |
| 300k / 400k | ≈267k / ≈367k | лише для моделей з вікном 1M |

- **▾ → «Поріг»:** «стисне на 167k (84% вікна) · ≈ через 3 ходи · вікно 200k, з налаштувань». Прогноз рахується за середнім ростом контексту на відповідь; прогріви в ньому не враховуються. Якщо автостиснення рушія вимкнено (`autoCompactEnabled`), рядок про це скаже.

## Знайомство при встановленні й оновленні

Після встановлення і після кожного оновлення смуга один раз відкриває 5 коротких сторінок:

1. що це за мод;
2. що показує смуга;
3. можливості: прогрівач, попередження, стиснення;
4. поріг автостиснення;
5. вибір налаштувань.

Після оновлення перша сторінка каже, що нового в цій версії. Наприкінці мод питає, які налаштування обрати:

- **★ Рекомендовані розробником:** поріг 200k, прогрівач 4 рази, пропозиція стиснення за 15 хв, усі блоки.
- **Свої:** наявні налаштування лишаються, відкривається ⚙.

«Пізніше» закриває сторінки до наступної сесії. ▾ → «ⓘ Про мод» відкриває їх будь-коли.

## Встановлення

**Windows, одним кліком (рекомендовано).** Завантажте [`windows/install.bat`](windows/install.bat) і [`windows/install.ps1`](windows/install.ps1) в одну теку, запустіть `install.bat` і перезапустіть Claude. Скрипт підключає мод у всіх акаунтах Claude на комп'ютері та вмикає автооновлення. Стару копію з архіву-інсталятора (`%LOCALAPPDATA%\claude-mods\gmdi-token-meter`) він прибирає. Перед зміною `settings.json` робить резервну копію.

**Термінал Claude Code** (будь-яка ОС):

```
/plugin install gmdi-token-meter --marketplace gennadijkhimij/gmdi-token-meter
```

Далі `y`, щоб додати маркетплейс, і Enter для області «user». Або з командного рядка:

```
claude plugin install gmdi-token-meter --marketplace gennadijkhimij/gmdi-token-meter
```

**Застосунок Claude:** «+» біля поля вводу → Plugins → Add marketplace → `gennadijkhimij/gmdi-token-meter` → Add plugin.

**Вручну** — додати в `~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "gmdi": { "source": { "source": "github", "repo": "gennadijkhimij/gmdi-token-meter" }, "autoUpdate": true }
},
"enabledPlugins": { "gmdi-token-meter@gmdi": true }
```

## Оновлення

Під час запуску Claude перевіряє маркетплейс і сам ставить нову версію, а потім пропонує перезапуск. Скрипт для Windows і ручний спосіб уже вмикають автооновлення. Якщо мод ставили через `/plugin install`, увімкніть його один раз: `/plugin` → Marketplaces → `gmdi` → Enable auto-update.

Вручну: `/plugin marketplace update gmdi`.

Видалення: `windows/uninstall.bat` або `/plugin` → Installed → gmdi-token-meter → Uninstall.

## Розробникам

- Код — `hooks/register.tsx`, переклади — `hooks/i18n.ts`, контракт стану — `types/index.d.ts`, тести — `hooks/band.test.tsx`.
- Перевірка: `claude plugin validate .` і `claude plugin test .`.
- Нова версія доходить до людей, лише коли піднято `version` у `.claude-plugin/plugin.json`: Claude оновлює плагін за номером версії.

---

## English

A mod for Claude Code (the Claude desktop app's Code tab and the terminal): a band above the prompt showing weekly (7D) and five-hour (5H) usage left with reset times (Claude sends those figures only with a reply, so once a reset time has passed in an idle session the mod counts that window as unused until the next reply), whether the prompt cache is still warm, and what the first request costs once it has gone cold. ▾ opens details, ⚙ opens settings (language uk/en, which blocks to show, cache TTL 1h or 5m, warmer, compact offer and auto-compact).

**Warnings.** For any sign-in (Free, Pro, Max, Team, Enterprise, API key, gateway): a window past 80 % (70/80/90 % or off in ⚙) gets a ⚠ and one toast with when it runs out at this pace; 95 % warns again and says whether extra usage or a stop comes next. A subscription's extra usage is read from the same endpoint as `/usage` (shared by all open sessions, at most every 5 minutes): the band shows `extra $52/$150`, and toasts come when it starts, at ⅓, ⅔ and 14/15 of the cap and at the cap. A budget in ⚙ ($50–500/month) is your own cap when it is below the organization's. With an API key the mod counts this computer's spend for the month and warns at the shares of that budget.

**Cache warmer.** Five minutes before the TTL runs out (one minute at 5m) the mod sends a one-word prompt that reads the cache and renews it, up to 4 times in a row by default (2, 8 or off in ⚙). Your next prompt restarts the count. It skips while Claude is working, below 20k context, below 10 % of the 5H limit or 5 % of the weekly one, and once the cache is cold. Each warm-up is a model turn and counts against your usage.

**Compact while the cache is warm.** With a large conversation, the first request after the cache cools writes the whole context again (804k tokens on Opus 5.5 ≈ $6.43), while compacting costs one warm read plus the summary (≈ $0.32), and the cold start after it rewrites only the summary and system prompt (≈ $0.56). When the cache is warm, cools within 15 minutes (10/15/20 or off in ⚙), a cold start would cost over $1 (0.5/1/2/5 in ⚙) and compacting halves that at least, a row under the band offers it: `⚠ cache cools in 14m: compact now ≈$0.32, then a cold start ≈$0.56 instead of $6.43 [⇲ Compact now] not now`. The button runs the same compaction as `/compact`: `$.session.compact()` in the terminal; the desktop app does not allow mods that call, so there the mod runs the `/compact` command itself (`$.command.run`), shown in the conversation as `/compact … Compacted`; it waits while Claude is working (also when a reply starts while it gets ready) and reports a veto (from any hook, in both cases) or failure. Auto-compact (off by default in ⚙) compacts an idle session five minutes before the cache cools (one minute at 5m), once per cache. While the warmer keeps the cache, there is no offer; the details say how long a break warming still beats compacting (warm-ups are counted whole, each one TTL less the warmer's lead apart). When the warmer is off, paused, used up or standing down on a low limit, the offer says so. The size after compaction (70k) and the summary length (8k) start as estimates and are learned from the first real compaction on the computer: the size the engine names, or, when it names none, the one the next turn's reply measures, however large (your own `/compact` counts too, unless a plugin that handles compaction before this mod hides it). A summary replaces the conversation in detail.

**Auto-compact threshold.** The engine compacts on its own at the auto-compact window less ≈33k; by default the window is the model's whole one, so on a 1M model a session grows to nearly a million tokens. ⚙ «Auto-compact threshold» offers engine default / 100k / ★ 200k (recommended) / 300k / 400k (the last two only matter on 1M models). A press runs the engine's `/autocompact <N>` at once, with no restart, and the engine saves it per model in `settings.json`; a refusal (for one, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set) comes as a toast and nothing is saved. Other open sessions apply it when idle. ▾ → «Threshold» reads «compacts at 167k (84% of the window) · ≈ in 3 turns · window 200k, from settings».

**Getting started.** After an install and after every update the band opens five short pages once: what the mod is, the band, what it can do, the threshold, and a choice: ★ the developer's recommended settings (200k, warmer ×4, compact offer at 15 min, every block) or your own (kept as they are; ⚙ opens). After an update the first page says what is new. «Later» leaves them for the next session; ▾ → «ⓘ About» brings them back.

**Install.** In a Claude Code terminal session:

```
/plugin install gmdi-token-meter --marketplace gennadijkhimij/gmdi-token-meter
```

In the desktop app: + next to the prompt box → Plugins → Add marketplace `gennadijkhimij/gmdi-token-meter` → Add plugin. On Windows, `windows/install.bat` does it for every Claude account on the machine with auto-update on.

**Updates.** Turn on auto-update once (`/plugin` → Marketplaces → `gmdi` → Enable auto-update; the Windows script and the settings snippet above already do), and Claude installs new versions on startup.

## License

Apache-2.0 © Gennadij Khimij
