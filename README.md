# gmdi-token-meter

Мод для Claude Code (застосунок Claude, вкладка Code, і термінал): смуга над полем вводу з лімітами, станом кешу запитів і ціною продовження розмови.

```
▾ ЛІМІТИ 7Д ●●●●●●···· 59% вільно · 3д 7г  5Г ●●●●●●●●●● 97% вільно · 2г 58хв  ТЕПЛО ще 1г 00хв ↻4 → $1.66
```

*English below.*

## Що показує

- **7Д і 5Г** — скільки лишилося тижневого й п'ятигодинного лімітів і коли вони скинуться. Колір: ≥80 % жовтий, ≥40 % помаранчевий, менше червоний.
- **ТЕПЛО / ХОЛОД** — чи ще живий кеш запитів після останньої відповіді і скільки йому лишилося (TTL 1h на підписці, 5m на API-ключі).
- **→ $X** — скільки коштуватиме перший запит, коли кеш охолоне й контекст доведеться записати заново.
- **▾** розгортає деталі: скидання лімітів за київським часом і прогноз на кінець вікна, стан кешу, ціна продовження, ціни для інших моделей, контекст і вартість сесії.
- **⚙** — налаштування: мова (uk/en), які блоки показувати, TTL кешу, прогрівач.

## Прогрівач кешу

Щоб простійна сесія не охолола і не довелося платити за повний перезапис контексту, мод за 5 хв до кінця TTL (за 1 хв при 5m) сам надсилає в сесію короткий запит «відповідай: ок». Запит читає кеш і продовжує його ще на TTL: ≈$0.04 замість ≈$1.66 за 200k контексту на Opus 5.5.

- Типово до **4** разів поспіль, у ⚙ можна 2, 8 або «вимк». Ваше повідомлення скидає лічильник.
- Не прогріває, поки Claude працює, при контексті менше 20k, коли лишилося < 10 % ліміту 5Г або < 5 % тижневого, і коли кеш уже холодний.
- `↻N` у смузі — скільки прогрівів ще лишилося. ▾ → «Прогрів»: коли наступний і скільки зроблено; кнопка «⏸ Не прогрівати цю сесію».
- Прогрів витрачає ліміт: кожен запит — це окремий хід моделі. Працює, лише поки сесія відкрита й комп'ютер не спить.

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

A mod for Claude Code (the Claude desktop app's Code tab and the terminal): a band above the prompt showing weekly (7D) and five-hour (5H) usage left with reset times, whether the prompt cache is still warm, and what the first request costs once it has gone cold. ▾ opens details, ⚙ opens settings (language uk/en, which blocks to show, cache TTL 1h or 5m, warmer).

**Cache warmer.** Five minutes before the TTL runs out (one minute at 5m) the mod sends a one-word prompt that reads the cache and renews it, up to 4 times in a row by default (2, 8 or off in ⚙). Your next prompt restarts the count. It skips while Claude is working, below 20k context, below 10 % of the 5H limit or 5 % of the weekly one, and once the cache is cold. Each warm-up is a model turn and counts against your usage.

**Install.** In a Claude Code terminal session:

```
/plugin install gmdi-token-meter --marketplace gennadijkhimij/gmdi-token-meter
```

In the desktop app: + next to the prompt box → Plugins → Add marketplace `gennadijkhimij/gmdi-token-meter` → Add plugin. On Windows, `windows/install.bat` does it for every Claude account on the machine with auto-update on.

**Updates.** Turn on auto-update once (`/plugin` → Marketplaces → `gmdi` → Enable auto-update; the Windows script and the settings snippet above already do), and Claude installs new versions on startup.

## License

Apache-2.0 © Gennadij Khimij
