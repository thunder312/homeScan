# homeScan

Heimnetz-Scanner mit interaktiver Netzwerkkarte. Erkennt Geräte per ARP/Ping, zeigt Hostnamen, Hersteller, Ports und Web-Interfaces, und visualisiert die Mesh-Topologie (FritzBox/FRITZ!Repeater).

## Installation via Docker (empfohlen)

### Voraussetzungen

- Linux-Host (z. B. Raspberry Pi, Synology NAS, Home Assistant OS, Ubuntu Server)
- [Docker](https://docs.docker.com/engine/install/) installiert
- Git installiert

### Erstmalige Installation

```bash
git clone https://github.com/thunder312/homeScan.git
cd homeScan
sudo docker compose up -d --build
```

Der erste Build lädt Node.js-Abhängigkeiten und kompiliert das Frontend — das dauert ein paar Minuten.

### Zugriff

| URL | Beschreibung |
|-----|-------------|
| `http://homescan.local` | mDNS-Name (funktioniert auf macOS, Linux, Windows mit Bonjour) |
| `http://<IP-des-Hosts>` | direkt per IP-Adresse |

### Updates einspielen

```bash
cd homeScan
git pull
sudo docker compose up -d --build
```

### Container stoppen / starten

```bash
sudo docker compose stop
sudo docker compose start
```

### Logs anzeigen

```bash
sudo docker compose logs -f
```

### Daten

Scan-Ergebnisse und FritzBox-Zugangsdaten werden im Verzeichnis `./data/` gespeichert (Docker-Volume-Mount). Die Daten bleiben bei Updates erhalten.

---

## FritzBox-Integration (optional)

Für Gerätenamen, WLAN/LAN-Erkennung und Mesh-Topologie kann ein FritzBox-Passwort hinterlegt werden. Einstellungen sind im Web-Interface unter dem Zahnrad-Symbol erreichbar.

---

## Lokale Entwicklung (ohne Docker)

```bash
npm install
npm run dev
```

Frontend läuft auf `http://localhost:8080`, Backend auf `http://localhost:3001`.
