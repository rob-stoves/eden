# Eden Desk Availability Display

A TV-friendly dashboard for displaying real-time desk availability using the Eden API.

## Deploying to Cloudflare Pages

### Option 1: Direct Upload (Easiest)

1. Go to [Cloudflare Pages](https://dash.cloudflare.com/?to=/:account/pages)
2. Click **"Create a project"** → **"Direct Upload"**
3. Name your project (e.g., `eden-desk-display`)
4. Upload this entire folder (drag & drop or select)
5. Click **"Deploy site"**

Your site will be live at `https://eden-desk-display.pages.dev` (or your chosen name).

### Option 2: Git Integration

1. Push this folder to a GitHub/GitLab repository
2. Go to [Cloudflare Pages](https://dash.cloudflare.com/?to=/:account/pages)
3. Click **"Create a project"** → **"Connect to Git"**
4. Select your repository
5. Configure build settings:
   - **Build command:** (leave empty)
   - **Build output directory:** `/`
6. Click **"Save and Deploy"**

## Project Structure

```
eden-desk-display/
├── index.html              # Main application
├── functions/
│   └── api/
│       └── [[path]].js     # Cloudflare Function (API proxy)
└── README.md
```

## How It Works

- The `index.html` file is the main application UI
- The `functions/api/[[path]].js` is a Cloudflare Pages Function that acts as a proxy
- When the app makes requests to `/api/locations`, the function forwards them to `https://public-api.eden.io/locations`
- This bypasses CORS restrictions that prevent direct browser requests to the Eden API

## Configuration

1. Open the deployed site
2. Your API token is pre-filled (or enter your Eden API token)
3. Click **"Load Locations"** to fetch available locations
4. Select your office/floor
5. Choose a refresh interval
6. Click **"Launch Display"**

Settings are saved in your browser's localStorage for automatic reconnection.

## Features

- 🖥️ **TV-optimized display** - Large text, high contrast, dark theme
- 🔄 **Auto-refresh** - Updates every 30s to 5 minutes
- 📍 **Location filtering** - Select specific floors or buildings
- 👤 **Occupant info** - Shows who booked each desk and time slots
- 📊 **Stats overview** - Quick count of available vs occupied desks
- ⚙️ **Persistent settings** - Remembers your configuration

## Troubleshooting

**"Failed to load locations"**
- Check that your API token is correct
- Verify the token has permissions to access locations

**"No desks found"**
- Try selecting a parent location (building/address) that contains desks
- Some locations may not have desk-type sub-locations

**Display not updating**
- Check the browser console (F12) for errors
- Verify your internet connection
- Try refreshing the page

## API Endpoints Used

- `GET /locations` - Fetch all locations
- `GET /locations?type=desks&parent_id=X` - Fetch desks for a location  
- `GET /cola_reservations?date=X&location_id=Y` - Fetch today's reservations
