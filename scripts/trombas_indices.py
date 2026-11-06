"""Índices convectivos para trombas marinas, vectorizados sobre muchos puntos de grilla.

Entrada: perfiles en niveles de presión (alturas, temperatura, humedad relativa, viento) más superficie.
Salida por punto: MLCAPE, MLCIN, MLLCL, MLCAPE 0–3 km, EL, MUCAPE, EBSMU, SRH 0–500 m (Bunkers
izquierdo), cizalle 0–6 km, gradientes 0–1 km, 0–3 km y 700–500 hPa, STP (hemisferio sur) y SHERBE.

Definiciones según Marín et al. (2024, MWR 152, ec. 1 y 2) y Coffer et al. (2019) para STP y SHERBE.
Simplificaciones declaradas (no cambian el orden de magnitud):
  - Ascenso pseudoadiabático integrado cada 5 hPa (RK2), con corrección de temperatura virtual.
  - CIN: área negativa entre el nivel de partida y el primer nivel con flotabilidad positiva.
  - EBSMU: viento en el nivel de la parcela más inestable contra el viento medio entre el 40 % y el 60 %
    de la altura del nivel de equilibrio (aproximación de la definición de thundeR).
"""
import numpy as np

RD, RV, CP, LV, G = 287.04, 461.5, 1005.7, 2.501e6, 9.80665
EPS, KAPPA = RD / RV, RD / CP
PF = np.arange(1050.0, 145.0, -5.0)          # grilla fina de presión (hPa)


def es_hpa(t_k):
    tc = t_k - 273.15
    return 6.112 * np.exp(17.67 * tc / (tc + 243.5))


def w_sat(t_k, p):
    e = es_hpa(t_k)
    return EPS * e / np.maximum(p - e, 1e-3)


def td_de_w(w, p):
    e = np.maximum(w * p / (EPS + w), 1e-6)
    ln = np.log(e / 6.112)
    return 243.5 * ln / (17.67 - ln) + 273.15


def t_lcl(t, td):  # Bolton (1980), ec. 15
    return 1.0 / (1.0 / (td - 56.0) + np.log(t / td) / 800.0) + 56.0


def theta_e(t, p, w):  # Bolton (1980), ec. 43
    tl = t_lcl(t, td_de_w(w, p))
    return t * (1000.0 / p) ** (0.2854 * (1 - 0.28 * w)) * np.exp((3.376 / tl - 0.00254) * w * 1e3 * (1 + 0.81 * w))


def dtdp_humedo(t, p):
    ws = w_sat(t, p)
    return (RD * t + LV * ws) / (p * (CP + LV * LV * ws * EPS / (RD * t * t)))


def a_grilla_fina(psfc, campo_sfc, P, campo_niv):
    """Interpola en ln p a la grilla fina PF. campo_niv: (N, L) en niveles P (descendentes). Bajo el suelo → NaN."""
    n = psfc.size
    out = np.full((n, PF.size), np.nan)
    lp, lps = np.log(P), np.log(psfc)
    for k, pk in enumerate(PF):
        sobre = pk <= psfc
        if pk > P[0]:
            lo_p, lo_v, hi_p, hi_v = lps, campo_sfc, np.full(n, lp[0]), campo_niv[:, 0]
        else:
            j = min(int(np.searchsorted(-P, -pk, side="right")) - 1, P.size - 2)
            usar_sfc = P[j] > psfc
            lo_p = np.where(usar_sfc, lps, lp[j]); lo_v = np.where(usar_sfc, campo_sfc, campo_niv[:, j])
            hi_p = np.full(n, lp[j + 1]); hi_v = campo_niv[:, j + 1]
        f = (np.log(pk) - lo_p) / np.where(hi_p == lo_p, 1e-9, hi_p - lo_p)
        out[sobre, k] = (lo_v + f * (hi_v - lo_v))[sobre]
    return out


def ascenso(p0, t0, w0, te_v, valido):
    """Temperatura virtual de la parcela en PF (NaN bajo el punto de partida) y presión del LCL."""
    n = p0.size
    tl = t_lcl(t0, td_de_w(w0, p0))
    plcl = p0 * (tl / t0) ** (1 / KAPPA)
    th = t0 * (1000.0 / p0) ** KAPPA
    tvp = np.full((n, PF.size), np.nan)
    tp = np.full(n, np.nan); p_ant = np.full(n, np.nan)
    for k, pk in enumerate(PF):
        act = (pk <= p0) & valido[:, k]
        seco = act & (pk > plcl)
        t_seco = th * (pk / 1000.0) ** KAPPA
        tp = np.where(seco, t_seco, tp)
        hum = act & (pk <= plcl)
        inicio = hum & ~(p_ant <= plcl)            # primer nivel húmedo: parte del LCL
        p_desde = np.where(inicio, plcl, p_ant); t_desde = np.where(inicio, tl, tp)
        dp = pk - p_desde
        k1 = dtdp_humedo(t_desde, p_desde)
        k2 = dtdp_humedo(t_desde + k1 * dp, pk)
        tp = np.where(hum, t_desde + 0.5 * (k1 + k2) * dp, tp)
        w = np.where(hum, w_sat(tp, pk), w0)
        tvp[:, k] = np.where(act, tp * (1 + 0.61 * w), np.nan)
        p_ant = np.where(act, pk, p_ant)
    return tvp, plcl


def integrales(tvp, tve, z_agl, p0):
    """CAPE, CIN, CAPE 0–3 km y altura del EL (m sobre el suelo) desde la flotabilidad en PF."""
    dlnp = np.log(PF[:-1] / PF[1:])
    b = tvp - tve                                     # K
    capa = RD * 0.5 * (b[:, :-1] + b[:, 1:]) * dlnp   # J/kg por capa
    capa = np.nan_to_num(capa)
    pos = capa > 0
    # EL: tope de la última capa con flotabilidad positiva
    idx = np.arange(capa.shape[1])
    ultimo = np.where(pos.any(1), np.max(np.where(pos, idx, -1), 1), -1)
    bajo_el = idx[None, :] <= ultimo[:, None]
    cape = np.where(pos & bajo_el, capa, 0).sum(1)
    primero = np.where(pos.any(1), np.argmax(pos, 1), capa.shape[1])
    cin = np.where((idx[None, :] < primero[:, None]) & ~pos, capa, 0).sum(1)
    zmed = 0.5 * (z_agl[:, :-1] + z_agl[:, 1:])
    cape3 = np.where(pos & bajo_el & (zmed <= 3000), capa, 0).sum(1)
    el = np.where(ultimo >= 0, z_agl[np.arange(len(ultimo)), np.minimum(ultimo + 1, z_agl.shape[1] - 1)], np.nan)
    cin = np.where(cape > 0, cin, 0.0)
    return cape, cin, cape3, el


def interp_altura(z_agl, campo, h):
    """Valor de campo (N, K) a la altura h (escalar o (N,)) sobre el suelo; z_agl crece con K (NaN bajo el suelo)."""
    n = z_agl.shape[0]
    h = np.broadcast_to(np.asarray(h, float), (n,))
    with np.errstate(invalid="ignore"):
        ge = z_agl >= h[:, None]
    hay = ge.any(1)
    k1 = np.argmax(ge, 1); k0 = k1 - 1
    r = np.arange(n); k0c = np.maximum(k0, 0)
    z0, z1, f0, f1 = z_agl[r, k0c], z_agl[r, k1], campo[r, k0c], campo[r, k1]
    ok = hay & (k0 >= 0) & np.isfinite(z0) & np.isfinite(f0) & np.isfinite(f1)
    with np.errstate(invalid="ignore", divide="ignore"):
        f = f0 + (h - z0) / np.where(z1 == z0, np.nan, z1 - z0) * (f1 - f0)
    return np.where(ok, f, np.nan)


def calcular(p, psfc, zsfc, t2, td2, u10, v10, gh, tt, rh, uu, vv):
    """p: niveles (L,) descendentes en hPa. Campos de superficie (N,); de niveles (N, L). Devuelve dict de (N,)."""
    q = {}
    w_niv = EPS * (rh / 100 * es_hpa(tt)) / np.maximum(p[None, :] - rh / 100 * es_hpa(tt), 1e-3)
    w2 = w_sat(td2, psfc)
    T = a_grilla_fina(psfc, t2, p, tt)
    W = a_grilla_fina(psfc, w2, p, w_niv)
    Z = a_grilla_fina(psfc, zsfc + 2.0, p, gh) - zsfc[:, None]
    U = a_grilla_fina(psfc, u10, p, uu)
    V = a_grilla_fina(psfc, v10, p, vv)
    valido = np.isfinite(T)
    TVE = T * (1 + 0.61 * W)
    pf = np.broadcast_to(PF, T.shape)

    # Parcela de capa mezclada (100 hPa inferiores)
    capa_ml = valido & (pf >= psfc[:, None] - 100)
    th = T * (1000.0 / pf) ** KAPPA
    th_ml = np.nanmean(np.where(capa_ml, th, np.nan), 1)
    w_ml = np.nanmean(np.where(capa_ml, W, np.nan), 1)
    t0 = th_ml * (psfc / 1000.0) ** KAPPA
    tvp, plcl = ascenso(psfc, t0, w_ml, TVE, valido)
    q["mlcape"], q["mlcin"], q["mlcape3"], q["el"] = integrales(tvp, TVE, Z, psfc)
    q["mllcl"] = interp_presion(pf, Z, plcl)

    # Parcela más inestable (máximo theta-e en los 300 hPa inferiores)
    capa_mu = valido & (pf >= psfc[:, None] - 300)
    te = np.where(capa_mu, theta_e(T, pf, W), -np.inf)
    kmu = np.argmax(te, 1); r = np.arange(len(kmu))
    p_mu, t_mu, w_mu = PF[kmu], T[r, kmu], W[r, kmu]
    tvp_mu, _ = ascenso(p_mu, t_mu, w_mu, TVE, valido)
    q["mucape"], _, _, el_mu = integrales(tvp_mu, TVE, Z, p_mu)
    h_mu = Z[r, kmu]

    # Cizalle efectivo de la parcela más inestable (EBSMU)
    u_mu, v_mu = U[r, kmu], V[r, kmu]
    capa_e = (Z >= (0.4 * el_mu)[:, None]) & (Z <= (0.6 * el_mu)[:, None])
    um = np.nanmean(np.where(capa_e, U, np.nan), 1); vm = np.nanmean(np.where(capa_e, V, np.nan), 1)
    eb = np.hypot(um - u_mu, vm - v_mu)
    q["ebsmu"] = np.where((q["mucape"] > 0) & np.isfinite(eb) & (el_mu > h_mu), eb, 0.0)

    # Viento por altura: cizalle 0–6 km y Bunkers izquierdo
    alt = np.arange(0, 6001, 250.0)
    ua = np.stack([interp_altura(Z, U, h) for h in alt], 1); va = np.stack([interp_altura(Z, V, h) for h in alt], 1)
    ua[:, 0], va[:, 0] = u10, v10
    q["bwd06"] = np.hypot(ua[:, -1] - u10, va[:, -1] - v10)
    q["shr01"] = np.hypot(ua[:, 4] - u10, va[:, 4] - v10)              # 0–1 km (alt[4] = 1000 m)
    umed, vmed = np.nanmean(ua, 1), np.nanmean(va, 1)
    sx = np.nanmean(ua[:, -3:], 1) - np.nanmean(ua[:, :3], 1)
    sy = np.nanmean(va[:, -3:], 1) - np.nanmean(va[:, :3], 1)
    s = np.maximum(np.hypot(sx, sy), 1e-6)
    cx, cy = umed - 7.5 * sy / s, vmed + 7.5 * sx / s      # movimiento izquierdo: V_med − D (S × k)/|S|
    # SRH 0–500 m cada 50 m
    hs = np.arange(0, 501, 50.0)
    us = np.stack([interp_altura(Z, U, h) for h in hs], 1); vs = np.stack([interp_altura(Z, V, h) for h in hs], 1)
    us[:, 0], vs[:, 0] = u10, v10
    ur, vr = us - cx[:, None], vs - cy[:, None]
    q["srh500"] = np.nansum(ur[:, 1:] * vr[:, :-1] - ur[:, :-1] * vr[:, 1:], 1)

    # Gradientes térmicos (positivos = enfriamiento con la altura, K/km)
    tz = lambda h: interp_altura(Z, T, h)
    q["lr01"] = (t2 - tz(1000)) / 1.0
    q["lr03"] = (t2 - tz(3000)) / 3.0
    t7, t5 = interp_presion_campo(pf, T, 700), interp_presion_campo(pf, T, 500)
    z7, z5 = interp_presion_campo(pf, Z, 700), interp_presion_campo(pf, Z, 500)
    q["lr75"] = (t7 - t5) / ((z5 - z7) / 1000.0)

    # STP (Marín et al. 2024, ec. 2; SRH con movimiento izquierdo → valores negativos en el HS)
    t_lcl_ = np.clip((2000 - q["mllcl"]) / 1000.0, 0, 1)
    t_cin = np.clip((200 + q["mlcin"]) / 150.0, 0, 1)
    t_eb = np.where(q["ebsmu"] < 12.5, 0, np.minimum(q["ebsmu"] / 20.0, 1.5))
    q["stp"] = (q["mlcape"] / 1500.0) * t_lcl_ * (q["srh500"] / 75.0) * t_eb * t_cin
    # SHERBE (Marín et al. 2024, ec. 1)
    q["sherbe"] = (q["ebsmu"] / 27.0) * (q["lr03"] / 5.2) * (q["lr75"] / 5.6)
    # VGP: cizalle medio 0–1 km × √CAPE (Caballero-Morán y Rondanelli, 2025, GRL; sin umbral publicado para Chile)
    q["vgp"] = (q["shr01"] / 1000.0) * np.sqrt(np.maximum(q["mlcape"], 0))
    # Ambiente de alto cizalle y bajo CAPE (HSLC) según Marín et al. (2026, Atmos. Res. 344): MUCAPE < 1000 J/kg,
    # EBSMU > 18 m/s y SHERBE ≥ 1. MeteoIA exige además MUCAPE > 0 (sin flotabilidad no hay convección).
    q["hslc"] = (q["mucape"] > 0) & (q["mucape"] < 1000) & (q["ebsmu"] > 18) & (q["sherbe"] >= 1)
    q["u850"] = interp_presion_campo(pf, U, 850); q["v850"] = interp_presion_campo(pf, V, 850)
    q["t850"] = interp_presion_campo(pf, T, 850)
    return q


def interp_presion_campo(pf, campo, p):
    k = int(np.argmin(np.abs(PF - p)))
    return campo[:, k]


def interp_presion(pf, Z, pl):
    """Altura (m s.n.s.) a la presión pl (N,) desde Z en la grilla fina."""
    out = np.full(pl.shape, np.nan)
    for i in range(pl.size):
        ok = np.isfinite(Z[i])
        if ok.sum() >= 2:
            out[i] = np.interp(np.log(pl[i]), np.log(PF[ok][::-1]), Z[i][ok][::-1])
    return out


def nst(lr01, mlcape3, mlcin, bwd06, zeta_ciclonica):
    """Non-Supercell Tornado Parameter (SPC/NWS). zeta_ciclonica > 0 = ciclónica (en el HS, −ζ)."""
    return (np.clip(lr01 / 9.0, 0, None) * np.clip(mlcape3 / 100.0, 0, None) * np.clip((225 + mlcin) / 200.0, 0, None)
            * np.clip((18 - bwd06) / 5.0, 0, None) * np.clip(zeta_ciclonica / 8e-5, 0, None))
