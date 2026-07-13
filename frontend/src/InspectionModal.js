import React from 'react';
import './InspectionModal.css';

// Renders one detention facility from detention_facilities.json.gz.
// Everything shown is sourced: official ICE FY26 statistics, published ODO
// inspection reports (linked), and a clearly-labeled AI-generated summary.
function InspectionModal({ isOpen, onClose, inspectionData, datasetMeta }) {
    if (!isOpen || !inspectionData) return null;

    const facility = inspectionData;
    const odo = facility.odo || null;
    const latest = odo && odo.latest_substantive;
    const stats = facility.stats || null;
    const lastIce = facility.last_ice_inspection || null;
    const provenance = facility.provenance || {};

    const findingsSections = latest ? [
        { key: 'SAFETY', label: 'Safety' },
        { key: 'SECURITY', label: 'Security' },
        { key: 'CARE', label: 'Care' },
        { key: 'ACTIVITIES', label: 'Activities' },
        { key: 'JUSTICE', label: 'Justice' }
    ].filter(s => latest.findings && latest.findings[s.key]) : [];

    const standardDeficiencies = latest && latest.standard_deficiencies
        ? Object.entries(latest.standard_deficiencies).sort((a, b) => b[1] - a[1])
        : [];

    // Insert missing spaces in dates like "March21-23"
    const formatInspectionDate = (dateString) => {
        if (!dateString || dateString === 'N/A') return dateString;
        return dateString.replace(/([A-Za-z])(\d)/g, '$1 $2');
    };

    const formatNumber = (n) => (typeof n === 'number' ? n.toLocaleString() : n);

    const place = [facility.city, facility.state].filter(Boolean).join(', ');
    const locationPrecisionNote = {
        address: 'pin placed at the facility street address',
        facility_name: 'pin placed at the named facility',
        city: 'pin placed at the city center (exact address not verified)'
    }[facility.location_precision];

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal inspection-modal" onClick={(e) => e.stopPropagation()}>
                <button className="modal-close" onClick={onClose}>×</button>
                <div
                    style={{
                        position: 'absolute',
                        top: '15px',
                        left: '15px',
                        backgroundColor: '#ff6b35',
                        color: 'white',
                        padding: '6px 12px',
                        borderRadius: '20px',
                        fontSize: '0.8rem',
                        fontWeight: '600',
                        zIndex: 10,
                        letterSpacing: '0.5px'
                    }}
                >
                    icemap.dev
                </div>
                <div className="modal-content">
                    <h1>{facility.name}</h1>
                    {(facility.address || place) && (
                        <p className="facility-address">
                            {[facility.address, place, facility.zip].filter(Boolean).join(', ')}
                        </p>
                    )}

                    {(facility.facility_type || facility.aor || stats || lastIce) && (
                        <div className="facility-info-section">
                            <h2>Facility Information <span className="source-tag">ICE FY2026 statistics</span></h2>
                            <table className="facility-info-table">
                                <tbody>
                                    {facility.facility_type && (
                                        <tr><td>Facility type</td><td>{facility.facility_type.label || facility.facility_type.code}</td></tr>
                                    )}
                                    {facility.aor && (
                                        <tr><td>ICE area of responsibility</td><td>{facility.aor.name} Field Office</td></tr>
                                    )}
                                    {facility.gender && (
                                        <tr><td>Population held</td><td>{facility.gender}</td></tr>
                                    )}
                                    {stats && stats.adp_fy26 !== null && stats.adp_fy26 !== undefined && (
                                        <tr><td>Average daily population (FY26 to date)</td><td>{formatNumber(Math.round(stats.adp_fy26))}</td></tr>
                                    )}
                                    {stats && stats.guaranteed_minimum_beds ? (
                                        <tr><td>Guaranteed minimum beds (contract)</td><td>{formatNumber(stats.guaranteed_minimum_beds)}</td></tr>
                                    ) : null}
                                    {stats && stats.avg_length_of_stay_days !== null && stats.avg_length_of_stay_days !== undefined && (
                                        <tr><td>Average length of stay</td><td>{stats.avg_length_of_stay_days} days</td></tr>
                                    )}
                                    {lastIce && lastIce.rating && (
                                        <tr>
                                            <td>Last contract inspection rating</td>
                                            <td>{lastIce.rating}{lastIce.end_date ? ` (${lastIce.type || 'inspection'} ended ${lastIce.end_date})` : ''}</td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {!provenance.in_fy26_stats && (
                        <p className="data-note">
                            This facility does not appear in ICE's current FY2026 facility statistics.
                            It may be closed, hold detainees only briefly, or fall below ICE's
                            reporting threshold; the inspection records below are historical.
                        </p>
                    )}

                    {facility.ai_summary && facility.ai_summary.text && (
                        <div className="summary-section">
                            <h2>Inspection History Summary <span className="source-tag ai-tag">AI-generated</span></h2>
                            <p>{facility.ai_summary.text}</p>
                            <small className="ai-disclosure">
                                Generated by an AI model ({facility.ai_summary.model}) from the linked
                                inspection reports on {facility.ai_summary.generated_date}. May contain
                                errors — verify against the original reports below.
                            </small>
                        </div>
                    )}

                    {latest && (
                        <div className="inspection-details">
                            <h2>Latest Detailed ODO Inspection <span className="source-tag">ICE Office of Detention Oversight</span></h2>
                            <p>
                                {latest.type || 'Inspection'} — {formatInspectionDate(latest.date)}
                                {typeof latest.total_deficiencies === 'number' && (
                                    <>
                                        {' · '}
                                        <strong>
                                            {latest.total_deficiencies} deficienc{latest.total_deficiencies === 1 ? 'y' : 'ies'} cited
                                        </strong>
                                    </>
                                )}
                            </p>

                            {standardDeficiencies.length > 0 && (
                                <div className="standard-deficiencies">
                                    <h3>Deficiencies by detention standard</h3>
                                    <table className="inspection-reports-table">
                                        <tbody>
                                            {standardDeficiencies.map(([standard, count]) => (
                                                <tr key={standard}>
                                                    <td>{standard}</td>
                                                    <td>{count}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            {latest.findings && latest.findings.CONCLUSION && (
                                <div className="conclusion-section">
                                    <h3>Report conclusion</h3>
                                    <p>{latest.findings.CONCLUSION}</p>
                                </div>
                            )}

                            {findingsSections.length > 0 && (
                                <div className="deficiency-descriptions">
                                    <h3>Findings by area</h3>
                                    {findingsSections.map((s) => (
                                        <div key={s.key} className="deficiency-description">
                                            <h4>{s.label}</h4>
                                            <p>{latest.findings[s.key]}</p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {odo && odo.inspections && odo.inspections.length > 0 && (
                        <div className="inspection-reports-container">
                            <h3 className="inspection-reports-label">All Published Inspection Reports</h3>
                            <table className="inspection-reports-table">
                                <thead>
                                    <tr>
                                        <th>Type</th>
                                        <th>Date</th>
                                        <th>Deficiencies</th>
                                        <th>Report</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {odo.inspections.map((insp, index) => (
                                        <tr key={index}>
                                            <td>{insp.type || 'N/A'}</td>
                                            <td>{formatInspectionDate(insp.date)}</td>
                                            <td>{typeof insp.total_deficiencies === 'number' ? insp.total_deficiencies : '—'}</td>
                                            <td>
                                                {insp.url ? (
                                                    <a href={insp.url} target="_blank" rel="noopener noreferrer">View</a>
                                                ) : '—'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {!odo && (
                        <p className="data-note">
                            No ODO compliance inspection reports for this facility have been
                            published in ICE's FOIA library.
                        </p>
                    )}

                    <div className="data-sources-section">
                        <h3>Data &amp; Sources</h3>
                        <ul className="data-sources-list">
                            {(datasetMeta && datasetMeta.sources ? datasetMeta.sources : [
                                { name: 'ICE Detention Statistics (facility-level)', url: 'https://www.ice.gov/detain/detention-management' },
                                { name: 'ICE ODO compliance inspection reports', url: 'https://www.ice.gov/foia/odo-foia-library' }
                            ]).map((s) => (
                                <li key={s.url}>
                                    <a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a>
                                </li>
                            ))}
                        </ul>
                        <small className="disclaimer" style={{ color: '#666' }}>
                            {provenance.match_method && provenance.match_method !== 'unmatched' && provenance.matched_fy26_name && (
                                <>Inspection records were matched to the official facility record
                                    "{provenance.matched_fy26_name}" ({provenance.match_method.replace(/_/g, ' ')}
                                    {provenance.match_score ? `, confidence ${provenance.match_score}` : ''}).{' '}</>
                            )}
                            {locationPrecisionNote && <>Map location: {locationPrecisionNote}.{' '}</>}
                            {datasetMeta && datasetMeta.generated_utc && (
                                <>Dataset generated {datasetMeta.generated_utc.slice(0, 10)}.{' '}</>
                            )}
                            Report inaccuracies to <a href="mailto:contact@icemap.dev">contact@icemap.dev</a>.
                        </small>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default InspectionModal;
