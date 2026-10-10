/**
 * Proxies that refuse every connection. Hook delivery to Foom's loopback receiver must
 * bypass them on every platform (#215).
 */
export const UNREACHABLE_PROXY: Readonly<Record<string, string>> = {
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "socks5://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  all_proxy: "socks5://127.0.0.1:9",
  NO_PROXY: "",
  no_proxy: "",
};
