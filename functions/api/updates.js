
export async function onRequestGet({ env }) {
    try {
        if (!env.DB) {
            return new Response(
                JSON.stringify({ error: "Database is not connected." }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" }
                }
            );
        }

        // Load all published updates, newest first.
        const result = await env.DB.prepare(`
            SELECT id, title, description, created_at
            FROM updates
            ORDER BY id DESC
        `).all();

        const updates = result.results || [];

        // Return an empty list when there are no updates.
        if (updates.length === 0) {
            return new Response(
                JSON.stringify({ success: true, updates: [] }),
                {
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        // Load all media connected to the published updates.
        const ids = updates.map(update => update.id);
        const placeholders = ids.map(() => "?").join(",");

        const mediaResult = await env.DB.prepare(`
            SELECT update_id, object_key, media_type
            FROM update_media
            WHERE update_id IN (${placeholders})
        `).bind(...ids).all();

        const mediaByUpdate = new Map();

        for (const item of mediaResult.results || []) {
            if (!mediaByUpdate.has(item.update_id)) {
                mediaByUpdate.set(item.update_id, []);
            }

            mediaByUpdate.get(item.update_id).push({
                type: item.media_type,
                url: `/api/media/${encodeURIComponent(item.object_key)}`
            });
        }

        // Attach photos and videos to each update.
        const finalUpdates = updates.map(update => ({
            ...update,
            media: mediaByUpdate.get(update.id) || []
        }));

        return new Response(
            JSON.stringify({
                success: true,
                updates: finalUpdates
            }),
            {
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store"
                }
            }
        );

    } catch (error) {
        console.error("Updates loading error:", error);

        return new Response(
            JSON.stringify({ error: "Could not load updates." }),
            {
                status: 500,
                headers: {
                    "Content-Type": "application/json; charset=utf-8"
                }
            }
        );
    }
}
