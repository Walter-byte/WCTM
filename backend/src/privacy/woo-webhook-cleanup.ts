const TOPICS = new Set([
  'order.created',
  'order.updated',
  'order.deleted',
  'order.restored',
  'product.created',
  'product.updated',
  'product.deleted',
  'product.restored',
]);

export interface RemoteWebhookCleanupInput {
  baseUrl: string;
  endpointKey: string | null;
  consumerKey: string;
  consumerSecret: string;
}

/** Delete only hooks with the Store's exact WCTM route, name and topic. */
export async function removeOwnedWooWebhooks(
  input: RemoteWebhookCleanupInput,
  request: typeof fetch = fetch
): Promise<{ complete: boolean; removed: number }> {
  if (!input.endpointKey) return { complete: true, removed: 0 };
  const authorization = `Basic ${Buffer.from(`${input.consumerKey}:${input.consumerSecret}`).toString('base64')}`;
  const base = input.baseUrl.endsWith('/')
    ? input.baseUrl
    : `${input.baseUrl}/`;
  let removed = 0;
  try {
    for (let page = 1; page <= 10; page++) {
      const listUrl = new URL(
        `wp-json/wc/v3/webhooks?per_page=100&page=${page}`,
        base
      );
      const response = await request(listUrl, {
        headers: { Authorization: authorization },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { complete: false, removed };
      const hooks: unknown = await response.json();
      if (!Array.isArray(hooks)) return { complete: false, removed };
      for (const candidate of hooks) {
        if (!candidate || typeof candidate !== 'object') continue;
        const hook = candidate as Record<string, unknown>;
        if (
          typeof hook['topic'] !== 'string' ||
          !TOPICS.has(hook['topic']) ||
          hook['name'] !== `WCTM Connector: ${hook['topic']}` ||
          typeof hook['delivery_url'] !== 'string' ||
          !Number.isSafeInteger(hook['id']) ||
          Number(hook['id']) <= 0
        )
          continue;
        let path: string;
        try {
          path = new URL(hook['delivery_url']).pathname;
        } catch {
          continue;
        }
        if (path !== `/api/webhooks/woocommerce/${input.endpointKey}`) continue;
        const deleteUrl = new URL(
          `wp-json/wc/v3/webhooks/${hook['id']}?force=true`,
          base
        );
        const deleted = await request(deleteUrl, {
          method: 'DELETE',
          headers: { Authorization: authorization },
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
        });
        if (!deleted.ok) return { complete: false, removed };
        removed++;
      }
      if (hooks.length < 100) return { complete: true, removed };
    }
  } catch {
    return { complete: false, removed };
  }
  return { complete: false, removed };
}
