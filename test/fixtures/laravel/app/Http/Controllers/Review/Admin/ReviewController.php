<?php
namespace App\Http\Controllers\Review\Admin;
use App\Http\Services\Review\ReviewService;
class ReviewController
{
    private $service;

    /** 注入示例审批服务。 */
    public function __construct(ReviewService $service)
    {
        $this->service = $service;
    }

    /** 调用服务，以验证控制器到服务的静态关联。 */
    public function approve()
    {
        $this->service->approve();
    }
}
