import { resolve } from "node:path";
import { Router } from "express";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { httpError } from "../middleware/errorHandler.js";

export const exhibitsRouter = Router();

// The parsed table or measured chart behind a source, for the preview panel.
exhibitsRouter.get("/exhibits/:key", async (req, res) => {
  if (!/^(table|chart)-\d+$/.test(req.params.key)) throw httpError(400, "Exhibit keys look like table-3 or chart-1");
  const { rows } = await pool.query(
    `SELECT key, kind, title, pdf_page AS "pdfPage", verified, data FROM exhibits WHERE key = $1 LIMIT 1`,
    [req.params.key],
  );
  if (!rows[0]) throw httpError(404, "Exhibit not found");
  res.json(rows[0]);
});

exhibitsRouter.get("/endnotes/:num", async (req, res) => {
  const num = Number(req.params.num);
  if (!Number.isInteger(num) || num < 1) throw httpError(400, "Endnote numbers are positive integers");
  const { rows } = await pool.query(`SELECT num, pdf_page AS "pdfPage", text, used_by AS "usedBy" FROM endnotes WHERE num = $1 LIMIT 1`, [num]);
  if (!rows[0]) throw httpError(404, "Endnote not found");
  res.json(rows[0]);
});

// The report itself, so a citation can open the PDF at the cited page (/report.pdf#page=12).
exhibitsRouter.get("/report.pdf", (_req, res) => {
  res.sendFile(resolve(config.reportPdf), { headers: { "Content-Type": "application/pdf" } });
});
