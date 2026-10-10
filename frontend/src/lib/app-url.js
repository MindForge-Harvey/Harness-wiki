/** Keep assets, navigation and API requests within the deployed application. */
export const appBase = import.meta.env.BASE_URL || "/";
export const appUrl = path => appBase + path.replace(/^\/+/, "");
