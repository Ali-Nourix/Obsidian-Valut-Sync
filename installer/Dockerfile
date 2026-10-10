FROM node:22-alpine
WORKDIR /app
COPY installer/ ./installer/
COPY supabase/schema.sql ./supabase/schema.sql
ENV HOST=0.0.0.0 PORT=8787
USER node
EXPOSE 8787
CMD ["node", "installer/server.mjs"]
