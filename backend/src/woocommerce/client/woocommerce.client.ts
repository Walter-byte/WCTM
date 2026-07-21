import axios from 'axios';

export interface WooCommerceClientOptions {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface WooCommerceConnectionResult {
  success: boolean;
  storeName?: string;
  error?: string;
}

interface SystemStatusResponse {
  store_name?: unknown;
  name?: unknown;
}

export class WooCommerceClient {
  constructor(private readonly options: WooCommerceClientOptions) {}

  async testConnection(): Promise<WooCommerceConnectionResult> {
    try {
      const response = await axios.get<unknown>(
        `${this.options.storeUrl.replace(/\/+$/, '')}/wp-json/wc/v3/system_status`,
        {
          auth: {
            username: this.options.consumerKey,
            password: this.options.consumerSecret,
          },
        }
      );
      const storeName = this.readStoreName(response.data);

      return {
        success: true,
        ...(storeName ? { storeName } : {}),
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response) {
        return {
          success: false,
          error: `WooCommerce connection failed with HTTP status ${error.response.status}`,
        };
      }

      return {
        success: false,
        error: 'Unable to connect to the WooCommerce store',
      };
    }
  }

  private readStoreName(value: unknown): string | undefined {
    if (value === null || typeof value !== 'object') {
      return undefined;
    }

    const status = value as SystemStatusResponse;
    const candidate = status.store_name ?? status.name;

    return typeof candidate === 'string' && candidate.trim() !== ''
      ? candidate
      : undefined;
  }
}
