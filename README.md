# CAPTURE

Gioco di conquista territoriale in tempo reale, nel browser: tu contro circa 240 bot (nazioni e tribù)
su una mappa del mondo reale o generata da un seme. Attacchi, edifici, navi, bombe nucleari, alleanze.
Vince chi controlla l'80% delle terre.

- Gioca: https://geeou.github.io/capture/ (installabile come app, in orizzontale su telefono)
- Stack: Vite + TypeScript + Canvas 2D, nessun framework. Quattro stili grafici: Radar, Ologramma, Tattico, Orbita.

## Sviluppo

```bash
npm install
npm run dev        # http://localhost:5266
npm run build      # typecheck + build in dist/
npx tsx tools/headless.ts 3000 world 1   # partita di soli bot senza grafica
```

L'architettura (nucleo della simulazione + un file per sistema) è descritta in `docs/CONTRACT.md`.
Ogni push su `main` pubblica su GitHub Pages tramite `.github/workflows/pages.yml`.
