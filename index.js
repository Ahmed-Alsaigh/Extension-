const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

gopeed.events.onResolve(async (ctx) => {
  const rawUrl = ctx.req.url;
  const settings = gopeed.settings || {};
  const scriptUrl = settings.scriptUrl
    ? settings.scriptUrl.trim().replace(/^https?:\/\//i, (m) => m.toLowerCase())
    : "";
  const apiKey = settings.apiKey ? settings.apiKey.trim() : "";
  const recursive =
    settings.recursive !== undefined ? Boolean(settings.recursive) : true;

  const parsed = parseDriveUrl(rawUrl);
  if (!parsed) {
    return;
  }

  // 1. Google Apps Script Web App (Option A)
  if (scriptUrl) {
    await resolveWithAppsScript(ctx, parsed, scriptUrl, recursive);
    return;
  }

  // 2. Google Drive API v3 (Option B)
  if (apiKey) {
    if (parsed.type === "folder") {
      await resolveFolderWithApi(ctx, parsed.id, apiKey, recursive);
    } else if (parsed.type === "file") {
      await resolveSingleFileWithApi(ctx, parsed.id, apiKey);
    } else {
      await resolveAutoWithApi(ctx, parsed.id, apiKey, recursive);
    }
    return;
  }

  // 3. Public HTML fallback
  if (parsed.type === "folder") {
    await resolveFolderFallback(ctx, parsed.id);
  } else {
    await resolveSingleFileFallback(ctx, parsed.id);
  }
});

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
    return { type: "auto", id: idParamMatch[1] };
  }

  return null;
}

async function resolveWithAppsScript(ctx, parsed, scriptUrl, recursive) {
  const separator = scriptUrl.includes("?") ? "&" : "?";
  const endpoint = `${scriptUrl}${separator}id=${encodeURIComponent(
    parsed.id
  )}&type=${encodeURIComponent(parsed.type)}&recursive=${recursive}`;

  const resp = await fetch(endpoint);
  if (!resp.ok) {
    throw new Error(`Apps Script HTTP ${resp.status}`);
  }

  const rawText = await resp.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error(
      "Apps Script returned non-JSON response. Ensure Web App access is set to Anyone."
    );
  }

  if (data.error) {
    throw new Error(`Apps Script error: ${data.error}`);
  }

  const rawItems = data.files || [];
  if (rawItems.length === 0) {
    throw new Error("No downloadable files found in this Drive link.");
  }

  // Verify if Drive API v3 stream endpoint is enabled for this Apps Script token
  let canUseDriveApiStream = false;
  const firstItem = rawItems[0];
  const probeHeaders = Object.assign(
    { "User-Agent": USER_AGENT, Range: "bytes=0-0" },
    firstItem.headers || {}
  );
  if (data.token && !probeHeaders.Authorization) {
    probeHeaders.Authorization = `Bearer ${data.token}`;
  }

  if (firstItem.url && firstItem.url.indexOf("googleapis.com/drive/v3") !== -1) {
    try {
      const probeResp = await fetch(firstItem.url, { headers: probeHeaders });
      if (probeResp.status === 200 || probeResp.status === 206) {
        canUseDriveApiStream = true;
      }
    } catch (e) {
      canUseDriveApiStream = false;
    }
  } else {
    canUseDriveApiStream = true;
  }

  const files = [];
  for (const item of rawItems) {
    const headers = Object.assign(
      { "User-Agent": USER_AGENT },
      item.headers || {}
    );
    if (data.token && !headers.Authorization) {
      headers.Authorization = `Bearer ${data.token}`;
    }

    let finalUrl = item.url;
    let finalHeaders = headers;

    if (!canUseDriveApiStream && item.id) {
      finalUrl = await resolveConfirmedUserContentUrl(item.id);
      finalHeaders = { "User-Agent": USER_AGENT };
    }

    files.push({
      name: item.name,
      path: item.path || "",
      size: item.size ? Number(item.size) : 0,
      req: {
        url: finalUrl,
        extra: {
          header: finalHeaders,
        },
      },
    });
  }

  ctx.res = {
    name: data.name || `GDrive_${parsed.id}`,
    range: true,
    files: files,
  };
}

async function resolveConfirmedUserContentUrl(fileId) {
  const initialUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download`;
  try {
    const resp = await fetch(initialUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Range: "bytes=0-8191",
      },
    });
    if (resp.ok) {
      const html = await resp.text();
      const confirmedUrl = extractFormDownloadUrl(html, fileId);
      if (confirmedUrl) {
        return confirmedUrl;
      }
    }
  } catch (e) {
    // Fall through to default confirm=t URL
  }
  return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
}

function extractFormDownloadUrl(html, fileId) {
  if (
    !html ||
    (html.indexOf("download-form") === -1 &&
      html.indexOf('name="uuid"') === -1 &&
      html.indexOf("uc-download-link") === -1)
  ) {
    return null;
  }

  const actionMatch =
    html.match(/<form[^>]*id=["']download-form["'][^>]*action=["']([^"']+)["']/i) ||
    html.match(
      /<form[^>]*action=["'](https:\/\/drive\.usercontent\.google\.com\/download[^"']*)["']/i
    );
  const baseUrl = actionMatch
    ? decodeHtmlEntities(actionMatch[1])
    : "https://drive.usercontent.google.com/download";

  const params = {};
  const inputRegex = /<input\b[^>]*>/gi;
  let inputMatch;
  while ((inputMatch = inputRegex.exec(html)) !== null) {
    const tag = inputMatch[0];
    if (/\btype=["']submit["']/i.test(tag)) {
      continue;
    }
    const nameMatch = tag.match(/\bname=["']([^"']+)["']/i);
    const valueMatch = tag.match(/\bvalue=["']([^"']*)["']/i);
    if (nameMatch && valueMatch) {
      params[nameMatch[1]] = decodeHtmlEntities(valueMatch[1]);
    }
  }

  if (!params.id) {
    params.id = fileId;
  }
  if (!params.export) {
    params.export = "download";
  }
  if (!params.confirm) {
    params.confirm = "t";
  }

  const queryParts = [];
  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key) && key !== "") {
      queryParts.push(
        encodeURIComponent(key) + "=" + encodeURIComponent(params[key])
      );
    }
  }

  const sep = baseUrl.indexOf("?") === -1 ? "?" : "&";
  return baseUrl + sep + queryParts.join("&");
}

async function resolveAutoWithApi(ctx, id, apiKey, recursive) {
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,size,mimeType&key=${apiKey}`;
  const resp = await fetch(metaUrl);
  if (!resp.ok) {
    throw new Error(`Drive API probe HTTP ${resp.status}`);
  }
  const meta = await resp.json();
  if (meta.mimeType === "application/vnd.google-apps.folder") {
    return resolveFolderWithApi(ctx, id, apiKey, recursive);
  }
  return resolveSingleFileWithApi(ctx, id, apiKey);
}

async function resolveFolderWithApi(ctx, folderId, apiKey, recursive) {
  const folderMetaUrl = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=name&key=${apiKey}`;
  const metaResp = await fetch(folderMetaUrl);
  if (!metaResp.ok) {
    throw new Error(`Drive API metadata HTTP ${metaResp.status}`);
  }
  const metaJson = await metaResp.json();
  const rootFolderName = metaJson.name || `GDrive_${folderId}`;

  const filesList = [];
  await fetchFolderChildren(folderId, "", apiKey, recursive, filesList);

  if (filesList.length === 0) {
    throw new Error("Folder is empty or inaccessible.");
  }

  ctx.res = {
    name: rootFolderName,
    range: true,
    files: filesList,
  };
}

async function fetchFolderChildren(
  folderId,
  currentPath,
  apiKey,
  recursive,
  filesList
) {
  let pageToken = "";
  do {
    const query = encodeURIComponent(
      `'${folderId}' in parents and trashed = false`
    );
    const fields = encodeURIComponent(
      "nextPageToken, files(id, name, mimeType, size)"
    );
    const apiUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&pageSize=1000&key=${apiKey}${
      pageToken ? `&pageToken=${pageToken}` : ""
    }`;

    const resp = await fetch(apiUrl);
    if (!resp.ok) {
      throw new Error(`Drive API list HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const items = data.files || [];

    for (const item of items) {
      if (item.mimeType === "application/vnd.google-apps.folder") {
        if (recursive) {
          const nextPath = currentPath
            ? `${currentPath}/${item.name}`
            : item.name;
          await fetchFolderChildren(
            item.id,
            nextPath,
            apiKey,
            recursive,
            filesList
          );
        }
      } else if (item.mimeType.startsWith("application/vnd.google-apps.")) {
        const exportUrl = `https://www.googleapis.com/drive/v3/files/${item.id}/export?mimeType=application/pdf&key=${apiKey}`;
        filesList.push({
          name: `${item.name}.pdf`,
          path: currentPath,
          size: 0,
          req: {
            url: exportUrl,
            extra: {
              header: { "User-Agent": USER_AGENT },
            },
          },
        });
      } else {
        const downloadUrl = `https://www.googleapis.com/drive/v3/files/${item.id}?alt=media&acknowledgeAbuse=true&key=${apiKey}`;
        filesList.push({
          name: item.name,
          path: currentPath,
          size: item.size ? parseInt(item.size, 10) : 0,
          req: {
            url: downloadUrl,
            extra: {
              header: { "User-Agent": USER_AGENT },
            },
          },
        });
      }
    }

    pageToken = data.nextPageToken || "";
  } while (pageToken);
}

async function resolveSingleFileWithApi(ctx, fileId, apiKey) {
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,mimeType&key=${apiKey}`;
  const resp = await fetch(metaUrl);
  if (!resp.ok) {
    throw new Error(`Drive API file HTTP ${resp.status}`);
  }
  const file = await resp.json();

  const isGoogleDoc =
    file.mimeType && file.mimeType.startsWith("application/vnd.google-apps.");
  const downloadUrl = isGoogleDoc
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/pdf&key=${apiKey}`
    : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&acknowledgeAbuse=true&key=${apiKey}`;

  ctx.res = {
    name: isGoogleDoc ? `${file.name}.pdf` : file.name,
    range: true,
    files: [
      {
        name: isGoogleDoc ? `${file.name}.pdf` : file.name,
        size: file.size ? parseInt(file.size, 10) : 0,
        req: {
          url: downloadUrl,
          extra: {
            header: { "User-Agent": USER_AGENT },
          },
        },
      },
    ],
  };
}

async function resolveFolderFallback(ctx, folderId) {
  const embedUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
  const resp = await fetch(embedUrl, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!resp.ok) {
    throw new Error(`Embedded folder HTTP ${resp.status}`);
  }
  const html = await resp.text();

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const folderName = titleMatch
    ? titleMatch[1].replace(/ - Google Drive$/i, "").trim()
    : `GDrive_${folderId}`;

  const entryRegex =
    /id="entry-([a-zA-Z0-9_-]+)"[\s\S]*?<div\s+class="flip-entry-title">([^<]+)<\/div>/g;
  const files = [];
  let match;
  while ((match = entryRegex.exec(html)) !== null) {
    const fileId = match[1];
    const fileName = decodeHtmlEntities(match[2].trim());
    const directUrl = await resolveConfirmedUserContentUrl(fileId);
    files.push({
      name: fileName,
      size: 0,
      req: {
        url: directUrl,
        extra: {
          header: { "User-Agent": USER_AGENT },
        },
      },
    });
  }

  if (files.length === 0) {
    throw new Error("No files found; configure an Apps Script URL or API Key.");
  }

  ctx.res = {
    name: folderName,
    range: true,
    files: files,
  };
}

async function resolveSingleFileFallback(ctx, fileId) {
  const viewUrl = `https://drive.google.com/file/d/${fileId}/view`;
  const resp = await fetch(viewUrl, {
    headers: { "User-Agent": USER_AGENT },
  });
  let fileName = `gdrive_${fileId}`;
  if (resp.ok) {
    const html = await resp.text();
    const titleMatch = html.match(
      /<meta\s+property="og:title"\s+content="([^"]+)"/i
    );
    if (titleMatch && titleMatch[1]) {
      fileName = decodeHtmlEntities(titleMatch[1]);
    }
  }

  const directUrl = await resolveConfirmedUserContentUrl(fileId);

  ctx.res = {
    name: fileName,
    range: true,
    files: [
      {
        name: fileName,
        size: 0,
        req: {
          url: directUrl,
          extra: {
            header: { "User-Agent": USER_AGENT },
          },
        },
      },
    ],
  };
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
