import 'dotenv/config';

/**
 * Notion OAuth Handler
 * Handles the OAuth 2.0 flow for Notion integration
 */

const NOTION_AUTH_URL = 'https://api.notion.com/v1/oauth/authorize';
const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';

export class NotionOAuth {
  constructor() {
    this.clientId = process.env.NOTION_CLIENT_ID;
    this.clientSecret = process.env.NOTION_CLIENT_SECRET;
    this.redirectUri = process.env.NOTION_REDIRECT_URI;
  }

  /**
   * Generate the OAuth authorization URL
   * @returns {string} The URL to redirect the user to
   */
  getAuthorizationUrl() {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      owner: 'user'
    });
    
    return `${NOTION_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   * @param {string} code - The authorization code from callback
   * @returns {Promise<Object>} Token response with access_token
   */
  async handleCallback(code) {
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    
    const response = await fetch(NOTION_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: this.redirectUri
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OAuth token exchange failed: ${error}`);
    }

    return await response.json();
  }

  /**
   * Validate if token is still valid
   * @param {string} accessToken - The access token to validate
   * @returns {Promise<boolean>}
   */
  async validateToken(accessToken) {
    try {
      const response = await fetch('https://api.notion.com/v1/users/me', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Notion-Version': '2022-06-28'
        }
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}
