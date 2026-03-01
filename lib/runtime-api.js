function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function getRuntimeApiBaseUrl() {
  return trimTrailingSlash(process.env.NEXT_PUBLIC_RUNTIME_API_BASE_URL || '');
}

export function runtimeApiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const baseUrl = getRuntimeApiBaseUrl();

  if (!baseUrl) {
    return normalizedPath;
  }

  return `${baseUrl}${normalizedPath}`;
}
