
import { getStore } from "@netlify/blobs";

const store = getStore("tower-bg-playtime");

export default async (request) => {
  try {
    if (request.method === "POST") {
      const secret = process.env.TOWER_BG_SECRET;

      if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = await request.json();
      const userId = String(body.userId || "");
      const username = String(body.username || "");
      const totalSeconds = Number(body.totalSeconds);

      if (!/^\d+$/.test(userId) ||
          !username ||
          !Number.isSafeInteger(totalSeconds) ||
          totalSeconds < 0) {
        return new Response("Invalid data", { status: 400 });
      }

      await store.setJSON(`player-${userId}`, {
        userId,
        username,
        totalSeconds
      });

      return Response.json({ success: true });
    }

    if (request.method === "GET") {
      const { blobs } = await store.list({ prefix: "player-" });

      const players = await Promise.all(
        blobs.map(async (blob) => {
          return await store.get(blob.key, { type: "json" });
        })
      );

      players.sort((a, b) => b.totalSeconds - a.totalSeconds);

      return Response.json({
        updatedAt: new Date().toISOString(),
        players
      });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    console.error(error);
    return new Response("Server error", { status: 500 });
  }
};
