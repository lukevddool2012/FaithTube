# FaithTube – instellingen die nog handmatig nodig zijn

Deze instructies horen bij de huidige GitHub-versie. Render-instellingen moeten door de eigenaar in het Render-dashboard worden aangepast.

## 1. Permanente opslag op Render

De huidige SQLite-database en lokale uploads staan zonder persistent disk op tijdelijke hostingopslag. Een Render persistent disk vereist een betaald web-serviceplan.

1. Maak eerst een back-up van de huidige database en de map met uploads. Schakel niet meteen over naar een nieuw DATABASE_PATH: dat maakt een lege database aan en de bestaande accounts/video's worden niet vanzelf overgezet.
2. Voeg bij de backendservice op Render een persistent disk toe met mount path `/var/data`.
3. Stel bij Environment in:
   - `DATABASE_PATH=/var/data/faithtube.db`
   - `UPLOAD_DIR=/var/data/uploads`
4. Deploy daarna pas. Controleer met een testaccount en testupload of alles na een herstart blijft bestaan.

## 2. Pushmeldingen inschakelen

De code ondersteunt Web Push, maar daarvoor zijn VAPID-sleutels nodig. Genereer die lokaal in de map `server` met:

```bash
npx web-push generate-vapid-keys
```

Voeg de getoonde sleutels toe aan Render Environment van de backend:

- `VAPID_PUBLIC_KEY` = de gegenereerde public key
- `VAPID_PRIVATE_KEY` = de gegenereerde private key
- `VAPID_SUBJECT` = `mailto: jouw-e-mailadres` (gebruik een echt contactadres)

De private key is geheim. Zet deze nooit in GitHub of in de frontend. Na een nieuwe deploy kunnen gebruikers in FaithTube bij Meldingen op 'Pushmeldingen inschakelen' drukken. De browser moet toestemming geven.

## 3. Ondertitels

FaithTube accepteert een openbare HTTPS-link naar een WebVTT-bestand dat eindigt op `.vtt`. Vul die link in bij Ondertitels tijdens het insturen van een video. De browser toont de ondertitels via de videospeler. Een bestand op je eigen computer kan nog niet rechtstreeks als ondertitelbestand worden geüpload.

## 4. Livestreams en apps

YouTube Live-, YouTube-video- en Vimeo-links kunnen als videolink worden ingestuurd en worden in de speler ingebed. De livestream zelf moet via YouTube of Vimeo worden uitgezonden.

De website is een installeerbare PWA. Een aparte native Android/iOS-app en publicatie in Google Play/App Store vereisen nog een aparte app-build, ontwikkelaarsaccounts, store-materiaal en beoordeling.

## 5. Juridische controle

De privacy- en voorwaardenpagina in de website is alleen een starttekst. Vul de juiste verantwoordelijke, contactgegevens, bewaartermijnen, rechtsgronden, hostingpartijen en formele auteursrecht-/klachtenprocedure in en laat de tekst controleren voordat FaithTube publiek wordt gelanceerd.

## 6. Dropbox voor video's en thumbnails

De server ondersteunt Dropbox-opslag voor nieuwe video-uploads en thumbnails. De bestanden worden in de Dropbox App Folder van de FaithTube-app gezet. Bestaande bestanden in de oude Render-map worden niet automatisch verplaatst.

1. Open de FaithTube-app in de Dropbox App Console.
2. Controleer bij **Permissions** dat deze rechten aanstaan en klik op **Submit**:
   - `files.content.read`
   - `files.content.write`
   - `files.metadata.read`
3. Kopieer bij **Settings** de App key en App secret.
4. Voeg bij de Render-backendservice onder **Environment** deze variabelen toe:
   - `DROPBOX_APP_KEY` = de App key uit Dropbox
   - `DROPBOX_APP_SECRET` = de App secret uit Dropbox
   - `DROPBOX_REDIRECT_URI` = `https://fathtube-server.onrender.com/dropbox/callback`
5. Voeg bij de Dropbox App Console onder **OAuth 2 → Redirect URIs** exact dezelfde redirect URI toe.
6. Deploy de server opnieuw en log in op FaithTube als beheerder.
7. Open het beheerdersdashboard en klik bij **Dropbox-opslag** op **Dropbox koppelen**. Geef toestemming in Dropbox.
8. De callback-pagina toont een geheime refresh token. Kopieer die en voeg hem bij Render toe als:
   - `DROPBOX_REFRESH_TOKEN`
9. Deploy opnieuw. In het FaithTube-beheerdersdashboard moet nu staan dat Dropbox actief is.

De refresh token is geheim. Zet hem alleen in de Render Environment-instellingen; niet in GitHub, de frontend of een chatbericht.

**Belangrijk:** Dropbox bewaart hiermee de videobestanden en thumbnails. De FaithTube-accounts, reacties, meldingen en overige gegevens staan nog in de SQLite-database. Op Render Free is die database zonder aparte permanente opslag nog steeds niet gegarandeerd blijvend. Ook bestaande video's in de oude lokale uploads-map worden niet automatisch gemigreerd. Maak eerst een back-up voordat je hosting of database-instellingen verandert.
