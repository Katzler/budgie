# Budgie 🪣

En hinkbudget för er två. Lönen kommer in på ett gemensamt Swedbank-konto och ni betalar med ett kort. Appen delar upp pengarna i hinkar (Livsmedel, Lyx, Resa …) och visar hur mycket som är kvar i varje hink.

- **Webbapp på GitHub Pages.** Ni lägger den på hemskärmen via Safari. Ingen App Store.
- **Supabase** sköter inloggning och databas (EU/Stockholm). Bara ni två kommer åt datan.
- **Köpen hämtas automatiskt från Swedbank** via Enable Banking (PSD2). Det sker fyra gånger per dygn och varje gång ni öppnar appen.
- **Notis efter varje köp**, t.ex. "ICA Maxi −342 kr · 🛒 Livsmedel: 2 158 kr kvar".
- **Överskott rullar vidare** och överdrag dras av nästa månad. Budgetmånaden börjar på lönedagen (den 25:e).
- **Apple Pay-genväg (valfri)** som ger besked direkt när ni betalar med telefonen.

Allt ryms i gratisnivåerna hos GitHub, Supabase och Enable Banking.

**Prova direkt:** öppna appen med `?demo` på slutet av adressen, eller innan `js/config.js` är ifylld. Då körs den med påhittad data som bara sparas i din webbläsare.

---

## Kom igång

Räkna med ungefär en timme. Du behöver [Node.js LTS](https://nodejs.org) (för Supabase CLI) och [Git](https://git-scm.com):

```bash
winget install OpenJS.NodeJS.LTS Git.Git
```

### 1. Supabase

1. Skapa ett projekt på [supabase.com](https://supabase.com). Välj regionen **Stockholm (eu-north-1)**.
2. Öppna **SQL Editor** och kör filerna i [supabase/migrations](supabase/migrations) i nummerordning, med början på `001_schema.sql`.
3. Gå till **Authentication → Sign In / Providers** och stäng av **Allow new users to sign up**.
4. Gå till **Authentication → Users → Add user** och skapa ett konto var. Kryssa i *Auto Confirm User*.
5. Koppla kontona till hushållet i SQL Editor:
   ```sql
   insert into members (user_id, name)
   select id, 'Jack' from auth.users where email = 'jack@exempel.se'
   union all
   select id, 'Namn' from auth.users where email = 'partner@exempel.se';
   ```

### 2. GitHub Pages

1. Fyll i `SUPABASE_URL` och `SUPABASE_KEY` i [js/config.js](js/config.js). Du hittar dem under **Project Settings → API**. Använd *publishable/anon key*, **aldrig** service role-nyckeln.
2. Skapa ett repo på GitHub och pusha:
   ```bash
   git init
   ```
   ```bash
   git add . && git commit -m "Budgie" && git branch -M main
   ```
   ```bash
   git remote add origin https://github.com/<användare>/budgie.git && git push -u origin main
   ```
   Repot kan vara publikt. Koden innehåller inga hemligheter, och ett privat repo kräver GitHub Pro för att Pages ska fungera.
3. Gå till **Settings → Pages → Deploy from a branch** och välj `main` och `/ (root)`. Appen hamnar på `https://<användare>.github.io/budgie/`.
4. Ställ in **Site URL** i Supabase under **Authentication → URL Configuration** till den adressen.

### 3. Enable Banking (Swedbank)

1. Skapa ett konto på [enablebanking.com](https://enablebanking.com) och öppna **Control Panel**.
2. Registrera en ny applikation:
   - **Environment:** Production
   - **Redirect URL:** exakt `https://<användare>.github.io/budgie/` (med snedstreck på slutet)
   - Välj att generera nyckeln i webbläsaren och spara `.pem`-filen. Lägg den **inte** i repot.
3. Under applikationen, välj **Link accounts**. Välj Swedbank och godkänn med BankID. Då aktiveras appen i *restricted mode*, som är gratis men bara får läsa era egna kopplade konton.
4. Notera **Application ID**.

Börjar filen med `BEGIN RSA PRIVATE KEY` måste den konverteras till PKCS#8:

```bash
openssl pkcs8 -topk8 -nocrypt -in nyckel.pem -out nyckel-pkcs8.pem
```

### 4. Notiser (VAPID-nycklar)

Öppna `https://<användare>.github.io/budgie/tools/vapid.html` och tryck **Skapa nycklar**.
- Den publika nyckeln ska in i `VAPID_PUBLIC_KEY` i `js/config.js`. Pusha ändringen.
- Spara båda nycklarna till nästa steg.

### 5. Edge functions

Kör från projektmappen:

```bash
npx supabase login
```
```bash
npx supabase link --project-ref <PROJECT_REF>
```

Sätt secrets. `CRON_SECRET` är ett långt slumpat lösenord som du hittar på själv.

```bash
npx supabase secrets set EB_APP_ID=<application id> APP_URL=https://<användare>.github.io/budgie/ CRON_SECRET=<slumpat> VAPID_PUBLIC_KEY=<publik> VAPID_PRIVATE_KEY=<privat> VAPID_SUBJECT=mailto:<din e-post>
```

Den privata nyckeln från Enable Banking sätter du enklast via **Edge Functions → Secrets** i Supabase. Klistra in hela PEM-filen som värde för `EB_PRIVATE_KEY`.

Driftsätt funktionerna (`--use-api` gör att Docker inte behövs):

```bash
npx supabase functions deploy api quick --use-api
```

### 6. Schemalagd hämtning

Öppna [supabase/cron.sql](supabase/cron.sql). Byt ut `<PROJECT_REF>` och `<CRON_SECRET>` och kör filen i SQL Editor.

### 7. På era iPhones

1. Öppna appens adress i **Safari** → **Dela** → **Lägg till på hemskärmen**.
2. Öppna Budgie från hemskärmen och logga in. Första gången väljer ni hinkar och belopp.
3. Gå till **Inställningar → Slå på notiser** och sedan **Skicka testnotis**.
4. Gå till **Inställningar → Bankkoppling → Koppla Swedbank med BankID**. Detta behöver bara en av er göra.
5. Vill ni ha direkt besked vid Apple Pay, sätt upp genvägen under **Inställningar → Apple Pay-genväg**.

---

## Så räknas det

| Begrepp | Betydelse |
|---|---|
| **Lönemånad** | Börjar på lönedagen (standard den 25:e). Infaller den på en helg börjar månaden närmaste vardag innan. |
| **Påfyllning** | När det finns pengar i Att fördela får hinkarna, i listans ordning, det som fattas av månadens månadsbelopp. Saldot går aldrig över hinkens **tak**. |
| **Överskott** | Det som blir kvar går till hinkar med överskott 1, sedan 2 och så vidare, upp till taket. Samma nummer delar lika. |
| **Väntetid** | De sista 7 dagarna före lönedagen fördelas inget, så att en lön som kommer tidigt (t.ex. före jul) fyller nästa månad. Den första lönemånaden fylls på för hand. |
| **Kvar i hinken** | Alla påfyllningar + flyttar in − flyttar ut + köp och återbetalningar sedan start. Överskott följer därför med till nästa månad, och överdrag dras av. |
| **Att fördela** | Startsaldo + inkomster − påfyllningar. Blir det minus har ni budgeterat mer än ni har. |
| **Osorterat** | Köp som ännu inte hamnat i någon hink. |
| **Kontrollsumma** | Hinkar + Att fördela + osorterat ska vara lika mycket som disponibelt belopp i banken. Appen visar ✓ eller skillnaden. |

Lön och flyttar till och från sparkonton är *inkomster*: de påverkar Att fördela och ligger inte i någon hink. Positiva belopp utan regel räknas automatiskt som inkomst.

**Regler:** när ni sorterar ett köp kommer appen ihåg butiken, t.ex. "ica maxi" → Livsmedel. Den längsta matchande regeln vinner. Det finns färdiga svenska regler för vanliga butiker.

**Kommande → bokfört:** dragningar som banken har registrerat men inte bokfört, t.ex. autogiro, syns som *Kommande* med bankens ofta förkortade text. När dragningen bokförs kopplas den ihop med den kommande raden (samma belopp och konto, inom ±5 dagar). Hinken följer med och texten byts mot den bokförda. Köp från Apple Pay-genvägen kopplas ihop på samma sätt men behåller sitt handlarnamn. Swedbank skickar inte kortreservationer, så kortköp dyker upp först när de bokförs.

**Egna pengar:** en privat hink med ägare syns bara för ägaren. Den andra ser inte hinken, köpen i den, flyttarna till och från den eller reglerna som sorterar dit, och får inga notiser om den. Hinken räknas ändå med i Att fördela och kontrollsumman, och månadsbeloppet syns under Inställningar eftersom det är en del av den gemensamma planen. Att sortera ett köp till en privat hink sparar ingen regel, så att den andras köp i samma butik inte hamnar där. Det döljs i appen, inte i databasen, och kontot är gemensamt, så köpen syns fortfarande i Swedbanks app.

**Avstängda konton:** rader från ett bankkonto som är avstängt under Inställningar → Bankkoppling räknas inte med och visas inte. Slås kontot på igen kommer de tillbaka.

## Filer

```
index.html, css/, js/              Webbappen (ren HTML/JS, inget byggsteg)
  js/app.js                        Vyer och router
  js/store.js                      Datalager: Supabase eller demoläge
supabase/functions/_shared/        Kod som delas mellan app och server
  budget.js                        Lönemånad, saldon, fördelning, belopp
  categorize.js                    Regler och matchning
supabase/functions/api/            Bankkoppling, hämtning, testnotis
supabase/functions/quick/          Apple Pay-genvägen
supabase/migrations/               Tabeller och Row Level Security, i nummerordning
supabase/cron.sql                  Hämtning 4 gånger per dygn
tests/                             Tester, öppna tests/index.html i webbläsaren
tools/vapid.html                   Skapar nycklar för notiser
```

## Utveckla lokalt

```bash
python -m http.server 8000
```

Öppna sedan `http://localhost:8000/?demo` för appen och `http://localhost:8000/tests/` för testerna.

## Bra att veta

- **Supabase pausar gratisprojekt** efter en veckas inaktivitet. Det händer inte så länge ni använder appen och den schemalagda hämtningen körs.
- **Bankmedgivandet gäller i upp till 180 dagar.** Appen skickar en påminnelse en vecka innan det går ut. Förnya under Inställningar → Bankkoppling.
- **PSD2 tillåter fyra hämtningar per dygn** när ingen använder appen. När ni öppnar appen hämtas nya köp direkt.
- **Säkerhet:** nyckeln i `config.js` är publik. Det är Row Level Security som skyddar datan: bara konton i `members` kan läsa eller skriva. Nya konton går inte att skapa eftersom registrering är avstängd.
