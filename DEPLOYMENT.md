# Deployment Guide

This project includes both a React frontend and a movie/series scraping API. You can deploy it to Vercel or Netlify.

## Vercel Deployment

### Prerequisites
- Vercel account (free tier available)
- Git repository (GitHub, GitLab, or Bitbucket)

### Steps

1. **Push your code to a Git repository**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git push origin main
   ```

2. **Connect to Vercel**
   - Go to [vercel.com](https://vercel.com)
   - Click "New Project"
   - Import your Git repository
   - Select your repo and click "Import"

3. **Configure Project Settings**
   - Framework Preset: Vite (should auto-detect)
   - Root Directory: ./
   - Build Command: `npm run build`
   - Output Directory: `dist`

4. **Deploy**
   - Click "Deploy"
   - Your site will be live in minutes!

### API Endpoints

Once deployed, your API will be available at:
```
https://your-domain.vercel.app/api/proxy
```

Available actions:
- `?action=catalog` - Get catalog structure
- `?action=posts&filter=/&page=1` - List posts
- `?action=search&query=keyword` - Search content
- `?action=meta&link=/path` - Get content details
- `?action=resolve&link=embed-url` - Resolve streaming links
- `?action=providers` - List available providers
- `?action=health` - Health check

## Netlify Deployment

### Prerequisites
- Netlify account (free tier available)
- Git repository

### Steps

1. **Convert to Netlify Functions** (Optional)
   If you want to use Netlify Functions instead, you would need to restructure the code to:
   ```
   netlify/functions/proxy.ts
   ```

2. **Push your code to Git**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git push origin main
   ```

3. **Connect to Netlify**
   - Go to [netlify.com](https://netlify.com)
   - Click "New site from Git"
   - Select your Git provider and repository
   - Click "Connect"

4. **Configure Build Settings**
   - Build command: `npm run build`
   - Publish directory: `dist`

5. **Deploy**
   - Click "Deploy site"
   - Your site will be live!

## Environment Variables

No environment variables are required for the basic API to work. The API uses public data sources.

If you plan to extend the API with authentication or private services, add environment variables through:
- **Vercel**: Settings → Environment Variables
- **Netlify**: Site Settings → Build & Deploy → Environment

## Testing the API

Once deployed, test your API with:

```bash
# Health check
curl "https://your-domain.vercel.app/api/proxy?action=health"

# Get catalog
curl "https://your-domain.vercel.app/api/proxy?action=catalog"

# Search
curl "https://your-domain.vercel.app/api/proxy?action=search&query=movie+name"
```

## Performance Notes

- API uses in-memory caching with TTLs
- Cache sizes are limited to 1000 entries per cache type
- Recommended for development and testing
- For production, consider adding Redis or database persistence

## Troubleshooting

- **Build fails**: Ensure all dependencies are installed (`npm install`)
- **API returns 404**: Check that the `api/` directory exists with `proxy.ts`
- **Slow responses**: Initial requests may be slow due to web scraping; subsequent requests use cache
