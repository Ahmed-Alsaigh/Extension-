const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

gopeed.events.onResolve(async (ctx) => {
  const rawUrl = ctx.req.url;
  const apiKey = (gopeed.settings && gopeed.settings.apiKey) ? gopeed.settings.apiKey.trim() : "";
  const recursive = gopeed.settings ? Boolean(gopeed.settings.recursive) : true;

  const parsed = parseDriveUrl(rawUrl);
  if (!parsed) {
    gopeed.logger.warn("Unrecognized Google Drive URL format: " + rawUrl);
    return;
  }

  try {
    if (parsed.type === "folder") {
      if (apiKey) {
        await resolveFolderWithApi(ctx, parsed.id, apiKey, recursive);
      } else {
        await resolveFolderFallback(ctx, parsed.id);
      }
    } else {
      if (apiKey) {
        await resolveSingleFileWithApi(ctx, parsed.id, apiKey);
      } else {
        await resolveSingleFileFallback(ctx, parsed.id);
      }
    }
  } catch (err) {
    gopeed.logger.error("Google Drive resolution failed: " + err.message);
  }
});

/**
 * Extracts type ('file' | 'folder') and ID from a Google Drive URL
 */
function parseDriveUrl(urlStr) {
  const folderMatch = urlStr.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) {
    return { type: "folder", id: folderMatch[1] };
  }

  const fileMatch = urlStr.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) {
    return { type: "file", id: fileMatch[1] };
  }

  const idParamMatch = urlStr.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) {
    return { type: "file", id: idParamMatch[1] };
  }

  return null;
}

/**
 * Resolves a folder (and optionally subfolders) using Google Drive API v3
 */
async function resolveFolderWithApi(ctx, folderId, apiKey, recursive) {
  const folderMetaUrl = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=name&key=${apiKey}`;
  const metaResp = await fetch(folderMetaUrl);
  let rootFolderName = `GDrive_${folderId}`;

  if (metaResp.ok) {
    const metaJson = await metaResp.json();
    if (metaJson.name) rootFolderName = metaJson.name;
  }

  const filesList = [];
  await fetchFolderChildren(folderId, "", apiKey, recursive, filesList);

  ctx.res = {
    name: rootFolderName,
    range: true,
    files: filesList,
  };
}

async function fetchFolderChildren(folderId, currentPath, apiKey, recursive, filesList) {
  let pageToken = "";

  do {
    const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const fields = encodeURIComponent("nextPageToken, files(id, name, mimeType, size)");
    const apiUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&pageSize=1000&key=${apiKey}${
      pageToken ? `&pageToken=${pageToken}` : ""
    }`;

    const resp = await fetch(apiUrl);
    if (!resp.ok) {
      throw new Error(`Drive API returned HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const items = data.files || [];

    for (const item of items) {
      if (item.mimeType === "application/vnd.google-apps.folder") {
        if (recursive) {
          const nextPath = currentPath ? `${currentPath}/${item.name}` : item.name;
          await fetchFolderChildren(item.id, nextPath, apiKey, recursive, filesList);
        }
      } else if (item.mimeType.startsWith("application/vnd.google-apps.")) {
        // Export Google Docs/Sheets/Slides as PDF so they are downloadable
        const exportUrl = `https://www.googleapis.com/drive/v3/files/${item.id}/export?mimeType=application/pdf&key=${apiKey}`;
        filesList.push({
          name: `${item.name}.pdf`,
          path: currentPath,
          size: 0,
          req: {
            url: exportUrl,
            headers: { "User-Agent": USER_AGENT },
          },
        });
      } else {
        // Direct binary file download via API alt=media
        const downloadUrl = `https://www.googleapis.com/drive/v3/files/${item.id}?alt=media&key=${apiKey}`;
        filesList.push({
          name: item.name,
          path: currentPath,
          size: item.size ? parseInt(item.size, 10) : 0,
          req: {
            url: downloadUrl,
            headers: { "User-Agent": USER_AGENT },
          },
        });
      }
    }

    pageToken = data.nextPageToken || "";
  } while (pageToken);
}

/**
 * Fallback folder parser (scrapes embedded public folder HTML when no API Key is set)
 */
async function resolveFolderFallback(ctx, folderId) {
  const embedUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
  const resp = await fetch(embedUrl, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch public folder view (${resp.status})`);
  }

  const html = await resp.text();
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const folderName = titleMatch ? titleMatch[1].replace(/ - Google Drive$/i, "").trim() : `GDrive_${folderId}`;

  // Match entry blocks in embeddedfolderview
  const entryRegex = /id="entry-([a-zA-Z0-9_-]+)"[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;
  const files = [];
  let match;

  while ((match = entryRegex.exec(html)) !== null) {
    const fileId = match[1];
    const fileName = decodeHtmlEntities(match[2].trim());
    files.push({
      name: fileName,
      size: 0,
      req: {
        url: buildDirectDownloadUrl(fileId),
        headers: { "User-Agent": USER_AGENT },
      },
    });
  }

  if (files.length === 0) {
    throw new Error("No files found or folder requires an API key.");
  }

  ctx.res = {
    name: folderName,
    range: true,
    files: files,
  };
}

/**
 * Resolves a single file using Google Drive API v3
 */
async function resolveSingleFileWithApi(ctx, fileId, apiKey) {
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,mimeType&key=${apiKey}`;
  const resp = await fetch(metaUrl);

  if (!resp.ok) {
    return resolveSingleFileFallback(ctx, fileId);
  }

  const file = await resp.json();
  const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;

  ctx.res = {
    name: file.name,
    range: true,
    files: [
      {
        name: file.name,
        size: file.size ? parseInt(file.size, 10) : 0,
        req: {
          url: downloadUrl,
          headers: { "User-Agent": USER_AGENT },
        },
      },
    ],
  };
}

/**
 * Fallback single-file resolver without API Key (bypasses virus scan confirmation)
 */
async function resolveSingleFileFallback(ctx, fileId) {
  const viewUrl = `https://drive.google.com/file/d/${fileId}/view`;
  const resp = await fetch(viewUrl, {
    headers: { "User-Agent": USER_AGENT },
  });

  let fileName = `gdrive_${fileId}`;
  if (resp.ok) {
    const html = await resp.text();
    const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (titleMatch && titleMatch[1]) {
      fileName = decodeHtmlEntities(titleMatch[1]);
    }
  }

  ctx.res = {
    name: fileName,
    range: true,
    files: [
      {
        name: fileName,
        size: 0,
        req: {
          url: buildDirectDownloadUrl(fileId),
          headers: { "User-Agent": USER_AGENT },
        },
      },
    ],
  };
}

function buildDirectDownloadUrl(fileId) {
  return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
