/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: process.env.NODE_ENV !== "development",
  webpack: (config, { isServer }) => {
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      fs: false,
      net: false,
      tls: false,
    };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    if (!config.resolve.alias) {
      config.resolve.alias = {};
    }
    config.resolve.alias["@react-native-async-storage/async-storage"] = false;

    for (const mod of [
      "@x402/evm",
      "@x402/evm/upto/client",
      "@x402/evm/exact/client",
      "@x402/svm",
      "@x402/svm/exact/client",
      "@x402/core",
      "@x402/core/client",
    ]) {
      config.resolve.alias[mod] = false;
    }

    if (!isServer) {
      const webpack = require("webpack");
      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ["buffer", "Buffer"],
          process: "process/browser",
        })
      );
      config.resolve.fallback = {
        ...config.resolve.fallback,
        buffer: require.resolve("buffer"),
      };
    }

    return config;
  },
};

module.exports = nextConfig;
